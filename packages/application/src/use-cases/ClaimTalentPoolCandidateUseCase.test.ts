import { describe, expect, it } from 'vitest';
import {
  AgeRange,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  Skill,
  SurfaceAffinities,
  TalentClaimPricingPolicy,
} from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, PlayerRepository, TalentClaimOutcome, TalentClaimPort } from '../ports/ports';
import { ClaimTalentPoolCandidateUseCase } from './ClaimTalentPoolCandidateUseCase';

class InMemoryPlayerRepository implements PlayerRepository {
  private readonly store = new Map<PlayerId, Player>();

  async findById(id: PlayerId): Promise<Player | null> {
    return this.store.get(id) ?? null;
  }

  async findByManager(managerId: ManagerId): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === managerId);
  }

  async findAll(): Promise<Player[]> {
    return [...this.store.values()];
  }

  async findFreeAgents(): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === null && !p.isRetired());
  }

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
  }
}

class FakeBillingPort implements BillingPort {
  constructor(private readonly pro = false) {}

  async isProSubscriber(): Promise<boolean> {
    return this.pro;
  }

  async createProCheckoutSession(): Promise<{ url: string }> {
    return { url: 'https://checkout.test/session' };
  }

  async customPlayerCreditBalance(): Promise<number> {
    return 0;
  }

  async consumeCustomPlayerCredit(): Promise<boolean> {
    return false;
  }
}

class FixedPricingPolicy implements TalentClaimPricingPolicy {
  readonly calls: Array<{ overallRating: number; ageInWeeks: number; ageRange: AgeRange }> = [];

  constructor(private readonly cost: number) {}

  priceFor(overallRating: number, ageInWeeks: number, ageRange: AgeRange): number {
    this.calls.push({ overallRating, ageInWeeks, ageRange });
    return this.cost;
  }
}

class FakeTalentClaimPort implements TalentClaimPort {
  readonly calls: Array<{ playerId: PlayerId; managerId: ManagerId; xpCost: number }> = [];
  nextOutcome: TalentClaimOutcome | null = null;

  constructor(private readonly players: InMemoryPlayerRepository) {}

  async claimAndCharge(playerId: PlayerId, managerId: ManagerId, xpCost: number): Promise<TalentClaimOutcome> {
    this.calls.push({ playerId, managerId, xpCost });
    if (this.nextOutcome) return this.nextOutcome;
    const player = await this.players.findById(playerId);
    if (!player || player.managerId !== null || player.isRetired()) return { kind: 'player-unavailable' };
    const signed = Player.reconstitute({
      id: player.id,
      name: player.name,
      nationality: player.nationality,
      ageInWeeks: player.ageInWeeks,
      managerId,
      attributes: player.attributes,
      stage: player.stage,
      fatigue: player.fatigue,
      form: player.form,
      potentialCeiling: player.potentialCeiling,
      physicalCeilings: player.physicalCeilings,
      talent: player.talent,
      experience: player.experience,
      dormantCarryoverBonus: player.dormantCarryoverBonus,
      fillOnly: false,
      careerPrizeMoney: player.careerPrizeMoney,
      seasonPrizeMoney: player.seasonPrizeMoney,
      seasonAgeAnchorWeeks: player.seasonAgeAnchorWeeks,
    });
    await this.players.save(signed);
    return { kind: 'claimed', player: signed, xpSpent: xpCost };
  }
}

function attributes(base = 50): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

function freeAgent(id: string): Player {
  return Player.generateFillOnly(PlayerId(id), `Free Agent ${id}`, 15 * 52, 'youth', attributes(), 'BR', 80, { speed: 80, stamina: 80, strength: 80 });
}

function ownedPlayer(id: string, managerId: ManagerId): Player {
  const player = Player.hire(PlayerId(id), `Owned ${id}`, 18 * 52, attributes(), managerId);
  player.pullDomainEvents();
  return player;
}

function setup(isPro = false) {
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  const billing = new FakeBillingPort(isPro);
  const talentClaim = new FakeTalentClaimPort(players);
  const pricing = new FixedPricingPolicy(123);
  const useCase = new ClaimTalentPoolCandidateUseCase(players, events, billing, talentClaim, pricing);
  return { players, events, talentClaim, pricing, useCase };
}

describe('ClaimTalentPoolCandidateUseCase', () => {
  it('signs an existing free-agent player, charges the computed XP, and publishes PlayerSigned', async () => {
    const { players, events, talentClaim, pricing, useCase } = setup();
    await players.save(freeAgent('p1'));

    const signed = await useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') });

    expect(signed.id).toBe('p1');
    expect(signed.managerId).toBe('m1');
    expect(signed.fillOnly).toBe(false);
    expect(talentClaim.calls).toEqual([{ playerId: PlayerId('p1'), managerId: ManagerId('m1'), xpCost: 123 }]);
    expect(pricing.calls).toHaveLength(1);
    expect(events.published).toEqual([{ type: 'PlayerSigned', payload: { playerId: PlayerId('p1'), managerId: ManagerId('m1') } }]);
  });

  it('throws a player-unavailable error when the atomic claim reports the player was already taken', async () => {
    const { players, talentClaim, useCase } = setup();
    await players.save(freeAgent('p1'));
    talentClaim.nextOutcome = { kind: 'player-unavailable' };

    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') })).rejects.toThrow(/no longer available/);
  });

  it('throws an insufficient-XP error when the atomic claim reports the manager cannot afford the player', async () => {
    const { players, talentClaim, useCase } = setup();
    await players.save(freeAgent('p1'));
    talentClaim.nextOutcome = { kind: 'insufficient-xp', required: 123, balance: 10 };

    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') })).rejects.toThrow(/insufficient XP/);
  });

  it('checks the roster cap before attempting to claim and charge', async () => {
    const { players, talentClaim, useCase } = setup(false);
    const managerId = ManagerId('m1');
    await players.save(ownedPlayer('owned-1', managerId));
    await players.save(ownedPlayer('owned-2', managerId));
    await players.save(freeAgent('p1'));

    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId })).rejects.toThrow(/roster is full/);
    expect(talentClaim.calls).toHaveLength(0);
  });
});