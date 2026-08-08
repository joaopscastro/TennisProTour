import { describe, expect, it } from 'vitest';
import {
  GameWorld,
  GeneratedPlayer,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  PlayerRarityTier,
  RandomSource,
  Skill,
  StandardAgingPolicy,
  StandardPlayerGenerationPolicy,
  SurfaceAffinities,
  TalentPoolCandidate,
  TalentPoolCandidateId,
  WorldId,
} from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository, TalentPoolCandidateRepository } from '../ports/ports';
import { RefreshTalentPoolUseCase } from './RefreshTalentPoolUseCase';
import { TALENT_POOL_AGE_RANGE } from './talentPoolAgeRange';

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

  async claimIfAvailable(id: TalentPoolCandidateId, managerId: ManagerId): Promise<TalentPoolCandidate | null> {
    const candidate = this.store.get(id);
    if (!candidate || !candidate.isAvailable()) return null;
    candidate.markClaimed(managerId);
    return candidate;
  }

  all(): TalentPoolCandidate[] {
    return [...this.store.values()];
  }
}

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
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

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
  }
}

class SequentialIdGenerator implements IdGeneratorPort {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

/** Always generates the same fixed player — the refresh use case
 * shouldn't care what the policy produces, only how many times it's
 * called and what it does with the result. */
class FixedGenerationPolicy {
  constructor(private readonly tier: PlayerRarityTier = 'common') {}
  generate(): GeneratedPlayer {
    return {
      name: 'Generated Player',
      nationality: 'BR',
      tier: this.tier,
      attributes: new PlayerAttributes({
        technical: { serve: Skill.of(30), forehand: Skill.of(30), backhand: Skill.of(30), volley: Skill.of(30) },
        physical: { speed: Skill.of(30), stamina: Skill.of(30), strength: Skill.of(30) },
        mental: { consistency: Skill.of(30), clutch: Skill.of(30) },
        surfaceAffinities: SurfaceAffinities.initial(),
      }),
      ageInWeeks: 750,
      potentialCeiling: 55,
      potentialTier: 'promising',
      physicalCeilings: { speed: 55, stamina: 55, strength: 55 },
    };
  }
}

class NullRandomSource implements RandomSource {
  next(): number {
    return 0;
  }
}

describe('RefreshTalentPoolUseCase', () => {
  it('generates a full batch of new available candidates', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const worlds = new InMemoryGameWorldRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const useCase = new RefreshTalentPoolUseCase(
      candidates,
      worlds,
      new FixedGenerationPolicy(),
      new NullRandomSource(),
      new SequentialIdGenerator(),
      new InMemoryPlayerRepository(),
      new RecordingEventPublisher(),
      undefined,
      5,
    );

    const result = await useCase.execute({ worldId });

    expect(result).toEqual({ generated: 5, expired: 0 });
    expect(candidates.all()).toHaveLength(5);
    expect(candidates.all().every((c) => c.isAvailable())).toBe(true);
    expect(candidates.all().every((c) => c.name === 'Generated Player')).toBe(true);
  });

  it('wires the REAL StandardPlayerGenerationPolicy with TALENT_POOL_AGE_RANGE, so every generated candidate lands in that exact 14-16yo window', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const worlds = new InMemoryGameWorldRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const useCase = new RefreshTalentPoolUseCase(
      candidates,
      worlds,
      new StandardPlayerGenerationPolicy(),
      { next: () => Math.random() },
      new SequentialIdGenerator(),
      new InMemoryPlayerRepository(),
      new RecordingEventPublisher(),
      undefined,
      20,
    );

    await useCase.execute({ worldId });

    expect(candidates.all()).toHaveLength(20);
    for (const candidate of candidates.all()) {
      expect(candidate.ageInWeeks).toBeGreaterThanOrEqual(TALENT_POOL_AGE_RANGE.minWeeks);
      expect(candidate.ageInWeeks).toBeLessThanOrEqual(TALENT_POOL_AGE_RANGE.maxWeeks);
    }
  });

  it('expires unclaimed candidates older than the pool expiry window, leaving fresher ones and claimed ones untouched — and no candidate row is ever deleted', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    // Current week is 4 — a candidate generated at week 1 is 3 weeks
    // old (past the 2-week expiry), one generated at week 3 is 1 week
    // old (still fine).
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 4 }));

    const generated = new FixedGenerationPolicy().generate();
    const stale = TalentPoolCandidate.generate(TalentPoolCandidateId('stale'), generated, { season: 1, week: 1 });
    const fresh = TalentPoolCandidate.generate(TalentPoolCandidateId('fresh'), generated, { season: 1, week: 3 });
    const alreadyClaimed = TalentPoolCandidate.generate(TalentPoolCandidateId('claimed'), generated, { season: 1, week: 1 });
    alreadyClaimed.markClaimed(ManagerId('m1'));
    await candidates.save(stale);
    await candidates.save(fresh);
    await candidates.save(alreadyClaimed);

    const useCase = new RefreshTalentPoolUseCase(
      candidates,
      worlds,
      new FixedGenerationPolicy(),
      new NullRandomSource(),
      new SequentialIdGenerator(),
      players,
      new RecordingEventPublisher(),
      undefined,
      0, // isolate expiry behavior from the generation batch for this test
    );

    const result = await useCase.execute({ worldId });

    expect(result.expired).toBe(1);
    // The row persists (not deleted) — this is the entire "must not be
    // deleted" requirement, verified against the SAME repository the
    // Scouting page's GET /talent-pool reads (findAvailable() below).
    expect((await candidates.findById(TalentPoolCandidateId('stale')))!.status).toBe('expired');
    expect((await candidates.findById(TalentPoolCandidateId('fresh')))!.status).toBe('available');
    // A candidate that was already claimed (not available) is never
    // touched by the expiry sweep, regardless of age.
    expect((await candidates.findById(TalentPoolCandidateId('claimed')))!.status).toBe('claimed');

    // No longer appears in the active/claimable list.
    const stillAvailable = await candidates.findAvailable();
    expect(stillAvailable.map((c) => c.id)).not.toContain('stale');
    expect(stillAvailable.map((c) => c.id)).toContain('fresh');
  });

  it('converts an expiring candidate into a real, permanent, fill-only Player — same id, no manager, still developable', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 4 }));

    const generated = new FixedGenerationPolicy().generate();
    const stale = TalentPoolCandidate.generate(TalentPoolCandidateId('stale'), generated, { season: 1, week: 1 });
    await candidates.save(stale);

    const useCase = new RefreshTalentPoolUseCase(
      candidates,
      worlds,
      new FixedGenerationPolicy(),
      new NullRandomSource(),
      new SequentialIdGenerator(),
      players,
      events,
      new StandardAgingPolicy(),
      0,
    );

    await useCase.execute({ worldId });

    const converted = await players.findById(PlayerId('stale'));
    expect(converted).not.toBeNull();
    expect(converted!.fillOnly).toBe(true);
    expect(converted!.managerId).toBeNull();
    expect(converted!.name).toBe('Generated Player');
    expect(converted!.ageInWeeks).toBe(750); // carried over unchanged from the candidate
    expect(converted!.stage).toBe('youth'); // 750 weeks (~14.4yo) is well under the 20yr prime threshold
    expect(converted!.attributes.attributeValue('serve')).toBe(30);

    expect(events.published.some((e) => e.type === 'FillOnlyPlayerGenerated' && e.payload.playerId === 'stale')).toBe(true);
  });

  it('computes the fill-only player stage from the REAL age, not a hardcoded youth default — an older expiring candidate lands in the right lifecycle stage', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 4 }));

    // 32 years old — StandardAgingPolicy's decline stage (30-38yo) —
    // this is only reachable in practice via a genesis-seeded fillOnly
    // player later re-entering... no, TALENT_POOL_AGE_RANGE keeps real
    // candidates at 14-16yo; this test exists purely to prove the
    // stage computation itself is correct for ANY age this method is
    // ever handed, not to claim a real candidate reaches this age today.
    const olderGenerated: GeneratedPlayer = { ...new FixedGenerationPolicy().generate(), ageInWeeks: 32 * 52 };
    const stale = TalentPoolCandidate.generate(TalentPoolCandidateId('older'), olderGenerated, { season: 1, week: 1 });
    await candidates.save(stale);

    const useCase = new RefreshTalentPoolUseCase(
      candidates,
      worlds,
      new FixedGenerationPolicy(),
      new NullRandomSource(),
      new SequentialIdGenerator(),
      players,
      new RecordingEventPublisher(),
      new StandardAgingPolicy(),
      0,
    );

    await useCase.execute({ worldId });

    expect((await players.findById(PlayerId('older')))!.stage).toBe('decline');
  });

  it('throws when the target game world does not exist', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const worlds = new InMemoryGameWorldRepository();
    const useCase = new RefreshTalentPoolUseCase(
      candidates,
      worlds,
      new FixedGenerationPolicy(),
      new NullRandomSource(),
      new SequentialIdGenerator(),
      new InMemoryPlayerRepository(),
      new RecordingEventPublisher(),
    );

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});
