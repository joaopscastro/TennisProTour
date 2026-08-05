import { describe, expect, it } from 'vitest';
import {
  GeneratedPlayer,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  Skill,
  SurfaceAffinities,
  TalentPoolCandidate,
  TalentPoolCandidateId,
} from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, PlayerRepository, TalentPoolCandidateRepository } from '../ports/ports';
import { ClaimTalentPoolCandidateUseCase } from './ClaimTalentPoolCandidateUseCase';

class InMemoryTalentPoolCandidateRepository implements TalentPoolCandidateRepository {
  private readonly store = new Map<TalentPoolCandidateId, TalentPoolCandidate>();

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
   * concurrent callers (see the concurrency test below) — the same
   * property the real Drizzle adapter gets from a single SQL
   * statement, here achieved by never yielding the event loop mid-check. */
  async claimIfAvailable(id: TalentPoolCandidateId, managerId: ManagerId): Promise<TalentPoolCandidate | null> {
    const candidate = this.store.get(id);
    if (!candidate || !candidate.isAvailable()) return null;
    candidate.markClaimed(managerId);
    return candidate;
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

describe('ClaimTalentPoolCandidateUseCase', () => {
  it('claims an available candidate and converts it into an owned Player with the same name/nationality/attributes', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    await seedCandidate(candidates, 'c1');
    const useCase = new ClaimTalentPoolCandidateUseCase(candidates, players, events, new FakeBillingPort());

    const player = await useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m1') });

    expect(player.name).toBe('Marta Silva');
    expect(player.nationality).toBe('BR');
    expect(player.managerId).toBe(ManagerId('m1'));
    expect(player.attributes.technical.serve.value).toBe(35);
    expect(player.stage).toBe('youth');
    // The candidate's hidden potentialCeiling transfers unchanged onto
    // the resulting Player — required for training's diminishing
    // returns to actually mean anything post-claim.
    expect(player.potentialCeiling).toBe(60);
    expect((await players.findByManager(ManagerId('m1')))).toHaveLength(1);
    expect(events.published.some((e) => e.type === 'PlayerHired')).toBe(true);

    // The candidate is no longer available once claimed.
    expect((await candidates.findById(TalentPoolCandidateId('c1')))!.status).toBe('claimed');
  });

  it('rejects a claim once the manager roster is full (free tier: 2)', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('m1');
    const useCase = new ClaimTalentPoolCandidateUseCase(candidates, players, events, new FakeBillingPort());

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
    const useCase = new ClaimTalentPoolCandidateUseCase(candidates, players, events, new FakeBillingPort(new Set(['pro-manager'])));

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
    await seedCandidate(candidates, 'c1');
    const useCase = new ClaimTalentPoolCandidateUseCase(candidates, players, events, new FakeBillingPort());

    await useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m1') });

    await expect(useCase.execute({ candidateId: TalentPoolCandidateId('c1'), managerId: ManagerId('m2') })).rejects.toThrow(
      /no longer available/,
    );
  });

  it('rejects claiming a candidate id that does not exist', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const useCase = new ClaimTalentPoolCandidateUseCase(candidates, players, events, new FakeBillingPort());

    await expect(
      useCase.execute({ candidateId: TalentPoolCandidateId('does-not-exist'), managerId: ManagerId('m1') }),
    ).rejects.toThrow(/no longer available/);
  });

  it('under concurrent claim attempts on the same candidate, exactly one succeeds', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    await seedCandidate(candidates, 'c1');
    const useCase = new ClaimTalentPoolCandidateUseCase(candidates, players, events, new FakeBillingPort());

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
});
