import { describe, expect, it } from 'vitest';
import {
  GeneratedPlayer,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  Skill,
  StandardTalentClaimPricingPolicy,
  SurfaceAffinities,
  TalentPoolCandidate,
  TalentPoolCandidateId,
} from '@tennis-manager/domain';
import {
  BillingPort,
  EventPublisherPort,
  PlayerRepository,
  TalentClaimOutcome,
  TalentClaimPort,
  TalentPoolCandidateRepository,
} from '../ports/ports';
import { ClaimTalentPoolCandidateUseCase } from './ClaimTalentPoolCandidateUseCase';

class InMemoryTalentPoolCandidateRepository implements TalentPoolCandidateRepository {
  readonly store = new Map<TalentPoolCandidateId, TalentPoolCandidate>();

  async findById(id: TalentPoolCandidateId): Promise<TalentPoolCandidate | null> {
    return this.store.get(id) ?? null;
  }

  async findAvailable(): Promise<TalentPoolCandidate[]> {
    return [...this.store.values()].filter((c) => c.isAvailable());
  }

  async save(candidate: TalentPoolCandidate): Promise<void> {
    this.store.set(candidate.id, candidate);
  }

  /** Deliberately no `await` between the availability check and the
   * mutation, so this fake actually behaves atomically under
   * concurrent callers (see the concurrency tests below) — the same
   * property the real Drizzle adapter gets from a single SQL
   * statement, here achieved by never yielding the event loop mid-check. */
  async claimIfAvailable(id: TalentPoolCandidateId, managerId: ManagerId): Promise<TalentPoolCandidate | null> {
    const candidate = this.store.get(id);
    if (!candidate || !candidate.isAvailable()) return null;
    candidate.markClaimed(managerId);
    return candidate;
  }
}

/**
 * Fakes TalentClaimPort.claimAndCharge() in memory. The whole method
 * body deliberately contains NO `await` — despite its async
 * signature, an async function with no internal await point runs
 * synchronously to completion once invoked, so this correctly
 * simulates the real Drizzle adapter's single-transaction atomicity
 * across both the candidate claim AND the XP debit. A version that
 * awaited between the balance check and the debit would NOT catch the
 * exact bug this port exists to prevent — see 'two near-simultaneous
 * claims race for a shared XP balance' below, which is specifically
 * designed to fail against such a naive (non-atomic) implementation.
 */
class InMemoryTalentClaimPort implements TalentClaimPort {
  private readonly balances = new Map<ManagerId, number>();

  constructor(private readonly candidates: InMemoryTalentPoolCandidateRepository) {}

  fundManager(managerId: ManagerId, amount: number): void {
    this.balances.set(managerId, amount);
  }

  balanceFor(managerId: ManagerId): number {
    return this.balances.get(managerId) ?? 0;
  }

  async claimAndCharge(candidateId: TalentPoolCandidateId, managerId: ManagerId, xpCost: number): Promise<TalentClaimOutcome> {
    const balance = this.balances.get(managerId) ?? 0;
    if (balance < xpCost) {
      return { kind: 'insufficient-xp', required: xpCost, balance };
    }
    const candidate = this.candidates.store.get(candidateId);
    if (!candidate || !candidate.isAvailable()) {
      return { kind: 'candidate-unavailable' };
    }
    candidate.markClaimed(managerId);
    this.balances.set(managerId, balance - xpCost);
    return { kind: 'claimed', candidate, xpSpent: xpCost };
  }
}

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

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }
}

class FakeBillingPort implements BillingPort {
  constructor(private readonly proManagers: Set<string> = new Set()) {}

  async isProSubscriber(managerId: ManagerId): Promise<boolean> {
    return this.proManagers.has(managerId);
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

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
  }
}

function generatedPlayer(overrides: Partial<GeneratedPlayer> = {}): GeneratedPlayer {
  return {
    name: 'Marta Silva',
    nationality: 'BR',
    tier: 'common',
    ageInWeeks: 750,
    attributes: new PlayerAttributes({
      technical: { serve: Skill.of(35), forehand: Skill.of(35), backhand: Skill.of(35), volley: Skill.of(35) },
      physical: { speed: Skill.of(35), stamina: Skill.of(35), strength: Skill.of(35) },
      mental: { consistency: Skill.of(35), clutch: Skill.of(35) },
      surfaceAffinities: SurfaceAffinities.initial(),
    }),
    potentialCeiling: 60,
    potentialTier: 'promising',
    ...overrides,
  };
}

async function seedCandidate(
  candidates: InMemoryTalentPoolCandidateRepository,
  id: string,
  overrides: Partial<GeneratedPlayer> = {},
): Promise<void> {
  await candidates.save(
    TalentPoolCandidate.generate(TalentPoolCandidateId(id), generatedPlayer(overrides), { season: 1, week: 1 }),
  );
}

/** Ample XP for every existing test below, which cares about roster
 * caps / claim races / not-found handling, not pricing itself —
 * pricing has its own dedicated tests further down. */
const AMPLE_XP = 100_000;

function makeUseCase(
  candidates: InMemoryTalentPoolCandidateRepository,
  players: InMemoryPlayerRepository,
  events: EventPublisherPort,
  billing: BillingPort,
  talentClaim: InMemoryTalentClaimPort,
): ClaimTalentPoolCandidateUseCase {
  return new ClaimTalentPoolCandidateUseCase(
    candidates,
    players,
    events,
    billing,
    talentClaim,
    new StandardTalentClaimPricingPolicy(),
  );
}

describe('ClaimTalentPoolCandidateUseCase', () => {
  it('claims an available candidate and converts it into an owned Player with the same name/nationality/attributes', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const talentClaim = new InMemoryTalentClaimPort(candidates);
    talentClaim.fundManager(ManagerId('m1'), AMPLE_XP);
    await seedCandidate(candidates, 'c1', { ageInWeeks: 777 });
    const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

    const player = await useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m1') });

    expect(player.name).toBe('Marta Silva');
    expect(player.nationality).toBe('BR');
    expect(player.managerId).toBe(ManagerId('m1'));
    expect(player.attributes.technical.serve.value).toBe(35);
    expect(player.stage).toBe('youth');
    // The resulting player's age is whatever the candidate was
    // generated with, not a fixed constant — closing the old gap where
    // every claimed player started at a fixed 18 years regardless of
    // what the candidate itself rolled.
    expect(player.ageInWeeks).toBe(777);
    // The candidate's hidden potentialCeiling transfers unchanged onto
    // the resulting Player — required for training's diminishing
    // returns to actually mean anything post-claim.
    expect(player.potentialCeiling).toBe(60);
    expect((await players.findByManager(ManagerId('m1')))).toHaveLength(1);
    expect(events.published.some((e) => e.type === 'PlayerHired')).toBe(true);

    // The candidate is no longer available once claimed.
    expect((await candidates.findById(TalentPoolCandidateId('c1')))!.status).toBe('claimed');

    // XP was actually spent, not just checked.
    expect(talentClaim.balanceFor(ManagerId('m1'))).toBeLessThan(AMPLE_XP);
  });

  it('rejects a claim once the manager roster is full (free tier: 2)', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('m1');
    const talentClaim = new InMemoryTalentClaimPort(candidates);
    talentClaim.fundManager(managerId, AMPLE_XP);
    const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

    for (let i = 1; i <= 2; i++) {
      await seedCandidate(candidates, `c${i}`);
      await useCase.execute({ candidateId: TalentPoolCandidateId(`c${i}`), managerId });
    }

    await seedCandidate(candidates, 'c3');
    await expect(useCase.execute({ candidateId: TalentPoolCandidateId('c3'), managerId })).rejects.toThrow(/roster is full/);
    // The 3rd candidate was never actually claimed — the cap check ran first.
    expect((await candidates.findById(TalentPoolCandidateId('c3')))!.status).toBe('available');
  });

  it('allows a Pro manager up to 4 players via BillingPort.isProSubscriber', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('pro-manager');
    const talentClaim = new InMemoryTalentClaimPort(candidates);
    talentClaim.fundManager(managerId, AMPLE_XP);
    const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(new Set(['pro-manager'])), talentClaim);

    for (let i = 1; i <= 4; i++) {
      await seedCandidate(candidates, `c${i}`);
      await useCase.execute({ candidateId: TalentPoolCandidateId(`c${i}`), managerId });
    }
    expect(await players.findByManager(managerId)).toHaveLength(4);

    await seedCandidate(candidates, 'c5');
    await expect(useCase.execute({ candidateId: TalentPoolCandidateId('c5'), managerId })).rejects.toThrow(/roster is full/);
  });

  it('rejects claiming a candidate that has already been claimed by someone else', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const talentClaim = new InMemoryTalentClaimPort(candidates);
    talentClaim.fundManager(ManagerId('m1'), AMPLE_XP);
    talentClaim.fundManager(ManagerId('m2'), AMPLE_XP);
    await seedCandidate(candidates, 'c1');
    const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

    await useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m1') });

    await expect(useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m2') })).rejects.toThrow(
      /no longer available/,
    );
  });

  it('rejects claiming a candidate id that does not exist', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const talentClaim = new InMemoryTalentClaimPort(candidates);
    const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

    await expect(
      useCase.execute({ candidateId: TalentPoolCandidateId('does-not-exist'), managerId: ManagerId('m1') }),
    ).rejects.toThrow(/no longer available/);
  });

  it('under concurrent claim attempts on the same candidate, exactly one succeeds', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const talentClaim = new InMemoryTalentClaimPort(candidates);
    talentClaim.fundManager(ManagerId('m1'), AMPLE_XP);
    talentClaim.fundManager(ManagerId('m2'), AMPLE_XP);
    talentClaim.fundManager(ManagerId('m3'), AMPLE_XP);
    await seedCandidate(candidates, 'c1');
    const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

    const attempts = await Promise.allSettled([
      useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m1') }),
      useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m2') }),
      useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m3') }),
    ]);

    const succeeded = attempts.filter((a) => a.status === 'fulfilled');
    const failed = attempts.filter((a) => a.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(2);
    for (const failure of failed as PromiseRejectedResult[]) {
      expect(String(failure.reason)).toMatch(/no longer available/);
    }

    // Only the one winning manager actually got a player out of it.
    const allPlayers = await players.findAll();
    expect(allPlayers).toHaveLength(1);
  });

  describe('XP pricing and balance', () => {
    it('rejects a claim when the manager cannot afford the candidate, spending nothing', async () => {
      const candidates = new InMemoryTalentPoolCandidateRepository();
      const players = new InMemoryPlayerRepository();
      const events = new RecordingEventPublisher();
      const talentClaim = new InMemoryTalentClaimPort(candidates);
      talentClaim.fundManager(ManagerId('m1'), 1); // nowhere near enough
      await seedCandidate(candidates, 'c1');
      const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

      await expect(useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m1') })).rejects.toThrow(
        /insufficient XP/,
      );

      // Nothing was spent, and the candidate is still available for
      // someone who CAN afford it.
      expect(talentClaim.balanceFor(ManagerId('m1'))).toBe(1);
      expect((await candidates.findById(TalentPoolCandidateId('c1')))!.status).toBe('available');
      expect(await players.findAll()).toHaveLength(0);
    });

    it('prices a stronger candidate strictly higher than a weaker one', async () => {
      const candidates = new InMemoryTalentPoolCandidateRepository();
      const players = new InMemoryPlayerRepository();
      const events = new RecordingEventPublisher();
      const talentClaim = new InMemoryTalentClaimPort(candidates);
      talentClaim.fundManager(ManagerId('m1'), AMPLE_XP);
      await seedCandidate(candidates, 'weak', {
        attributes: new PlayerAttributes({
          technical: { serve: Skill.of(20), forehand: Skill.of(20), backhand: Skill.of(20), volley: Skill.of(20) },
          physical: { speed: Skill.of(20), stamina: Skill.of(20), strength: Skill.of(20) },
          mental: { consistency: Skill.of(20), clutch: Skill.of(20) },
          surfaceAffinities: SurfaceAffinities.initial(),
        }),
      });
      await seedCandidate(candidates, 'strong', {
        attributes: new PlayerAttributes({
          technical: { serve: Skill.of(80), forehand: Skill.of(80), backhand: Skill.of(80), volley: Skill.of(80) },
          physical: { speed: Skill.of(80), stamina: Skill.of(80), strength: Skill.of(80) },
          mental: { consistency: Skill.of(80), clutch: Skill.of(80) },
          surfaceAffinities: SurfaceAffinities.initial(),
        }),
      });
      const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

      await useCase.execute({ candidateId: TalentPoolCandidateId('weak'), managerId: ManagerId('m1') });
      const balanceAfterWeak = talentClaim.balanceFor(ManagerId('m1'));
      const weakCost = AMPLE_XP - balanceAfterWeak;

      await useCase.execute({ candidateId: TalentPoolCandidateId('strong'), managerId: ManagerId('m1') });
      const balanceAfterStrong = talentClaim.balanceFor(ManagerId('m1'));
      const strongCost = balanceAfterWeak - balanceAfterStrong;

      expect(strongCost).toBeGreaterThan(weakCost);
    });

    it('under two near-simultaneous claims that together exceed the balance but neither alone does, exactly one succeeds', async () => {
      const candidates = new InMemoryTalentPoolCandidateRepository();
      const players = new InMemoryPlayerRepository();
      const events = new RecordingEventPublisher();
      const talentClaim = new InMemoryTalentClaimPort(candidates);
      const managerId = ManagerId('m1');

      // Two DISTINCT candidates (so the single-candidate claim race
      // above doesn't already protect this) each priced comfortably
      // affordable alone, but not both together — this isolates the
      // XP-balance race specifically, independent of the candidate-
      // claim race: a naive "check balance, then separately debit"
      // implementation would let both checks pass before either
      // debits, since they're for different candidate rows.
      await seedCandidate(candidates, 'c1');
      await seedCandidate(candidates, 'c2');
      const pricingPolicy = new StandardTalentClaimPricingPolicy();
      const rating = generatedPlayer().attributes.overallRating();
      const costPerCandidate = pricingPolicy.priceFor(rating);
      talentClaim.fundManager(managerId, costPerCandidate + Math.floor(costPerCandidate / 2)); // covers 1, not 2

      const useCase = makeUseCase(candidates, players, events, new FakeBillingPort(), talentClaim);

      const attempts = await Promise.allSettled([
        useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId }),
        useCase.execute({ candidateId: TalentPoolCandidateId('c2'), managerId }),
      ]);

      const succeeded = attempts.filter((a) => a.status === 'fulfilled');
      expect(succeeded).toHaveLength(1);

      // The balance never went negative — the hallmark of the race
      // this port exists to prevent.
      expect(talentClaim.balanceFor(managerId)).toBeGreaterThanOrEqual(0);
      expect(await players.findAll()).toHaveLength(1);
    });
  });
});
