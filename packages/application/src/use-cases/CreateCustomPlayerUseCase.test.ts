import { describe, expect, it } from 'vitest';
import {
  GeneratedPlayer,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  RandomSource,
  Skill,
  SurfaceAffinities,
} from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, PlayerRepository } from '../ports/ports';
import { CreateCustomPlayerUseCase } from './CreateCustomPlayerUseCase';

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

/** Configurable fake so tests can exercise both the "Pro + credits"
 * happy path and each individual gate (not Pro / roster full / no
 * credits) in isolation. */
class FakeBillingPort implements BillingPort {
  public credits = 0;
  public consumeCalls = 0;

  constructor(private isPro: boolean = true) {}

  async isProSubscriber(): Promise<boolean> {
    return this.isPro;
  }

  async createProCheckoutSession(): Promise<{ url: string }> {
    return { url: 'https://checkout.test/session' };
  }

  async customPlayerCreditBalance(): Promise<number> {
    return this.credits;
  }

  async consumeCustomPlayerCredit(): Promise<boolean> {
    this.consumeCalls += 1;
    if (this.credits <= 0) return false;
    this.credits -= 1;
    return true;
  }
}

function fixedAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(55), forehand: Skill.of(55), backhand: Skill.of(55), volley: Skill.of(55) },
    physical: { speed: Skill.of(55), stamina: Skill.of(55), strength: Skill.of(55) },
    mental: { consistency: Skill.of(55), clutch: Skill.of(55) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

/** Records every call it receives, so tests can assert the SAME
 * generation policy a talent-pool refresh would use is what actually
 * produced this player's attributes — the fairness constraint this
 * use case's doc comment insists on. */
class RecordingGenerationPolicy {
  calls = 0;
  generate(): GeneratedPlayer {
    this.calls += 1;
    return {
      name: 'ignored — command.name wins',
      nationality: 'ignored',
      tier: 'common',
      ageInWeeks: 799,
      attributes: fixedAttributes(),
      potentialCeiling: 72,
      potentialTier: 'high',
      physicalCeilings: { speed: 80, stamina: 80, strength: 80 },
      talent: 65,
    };
  }
}

class NullRandomSource implements RandomSource {
  next(): number {
    return 0;
  }
}

describe('CreateCustomPlayerUseCase', () => {
  it('creates a player for a Pro manager with credits, spending exactly one credit and using the injected generation policy for attributes', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const billing = new FakeBillingPort(true);
    billing.credits = 3;
    const generationPolicy = new RecordingGenerationPolicy();
    const useCase = new CreateCustomPlayerUseCase(players, events, billing, generationPolicy, new NullRandomSource());

    const player = await useCase.execute({
      playerId: PlayerId('p1'),
      managerId: ManagerId('m1'),
      name: 'Custom Name',
      nationality: 'FR',
    });

    expect(player.name).toBe('Custom Name'); // the manager's chosen name, not the policy's
    expect(player.nationality).toBe('FR');
    expect(player.attributes.technical.serve.value).toBe(55); // came from the generation policy
    expect(player.potentialCeiling).toBe(72); // also came from the SAME generation policy call
    expect(player.physicalCeilings).toEqual({ speed: 80, stamina: 80, strength: 80 }); // same, per-attribute
    // Age also comes from the generation policy now — no manager-chosen
    // age, and no separate fixed "starting age" constant either.
    expect(player.ageInWeeks).toBe(799);
    expect(generationPolicy.calls).toBe(1);
    expect(billing.credits).toBe(2); // exactly one credit spent
    expect(events.published.some((e) => e.type === 'PlayerHired')).toBe(true);
  });

  it('rejects a non-Pro manager without ever touching credits', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const billing = new FakeBillingPort(false);
    billing.credits = 5;
    const useCase = new CreateCustomPlayerUseCase(players, events, billing, new RecordingGenerationPolicy(), new NullRandomSource());

    await expect(
      useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1'), name: 'X', nationality: 'FR' }),
    ).rejects.toThrow(/Manager Pro/);
    expect(billing.consumeCalls).toBe(0);
    expect(billing.credits).toBe(5); // untouched
  });

  it('rejects when the manager has no custom player credits remaining, without creating a player', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const billing = new FakeBillingPort(true);
    billing.credits = 0;
    const useCase = new CreateCustomPlayerUseCase(players, events, billing, new RecordingGenerationPolicy(), new NullRandomSource());

    await expect(
      useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1'), name: 'X', nationality: 'FR' }),
    ).rejects.toThrow(/no custom player credits/);
    expect(await players.findAll()).toHaveLength(0);
  });

  it('rejects once the Pro roster cap (4) is reached, without spending a credit', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const billing = new FakeBillingPort(true);
    billing.credits = 10;
    const useCase = new CreateCustomPlayerUseCase(players, events, billing, new RecordingGenerationPolicy(), new NullRandomSource());
    const managerId = ManagerId('m1');

    for (let i = 1; i <= 4; i++) {
      await useCase.execute({ playerId: PlayerId(`p${i}`), managerId, name: `Player ${i}`, nationality: 'FR' });
    }
    const creditsAfterFour = billing.credits;

    await expect(
      useCase.execute({ playerId: PlayerId('p5'), managerId, name: 'One Too Many', nationality: 'FR' }),
    ).rejects.toThrow(/roster is full/);
    expect(billing.credits).toBe(creditsAfterFour); // the 5th attempt never spent a credit
  });
});
