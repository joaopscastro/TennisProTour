import { describe, expect, it } from 'vitest';
import {
  GameWorld,
  GeneratedPlayer,
  ManagerId,
  PlayerAttributes,
  PlayerRarityTier,
  RandomSource,
  Skill,
  StandardPlayerGenerationPolicy,
  SurfaceAffinities,
  TalentPoolCandidate,
  TalentPoolCandidateId,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, IdGeneratorPort, TalentPoolCandidateRepository } from '../ports/ports';
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
      20,
    );

    await useCase.execute({ worldId });

    expect(candidates.all()).toHaveLength(20);
    for (const candidate of candidates.all()) {
      expect(candidate.ageInWeeks).toBeGreaterThanOrEqual(TALENT_POOL_AGE_RANGE.minWeeks);
      expect(candidate.ageInWeeks).toBeLessThanOrEqual(TALENT_POOL_AGE_RANGE.maxWeeks);
    }
  });

  it('expires unclaimed candidates older than the pool expiry window, leaving fresher ones and claimed ones untouched', async () => {
    const candidates = new InMemoryTalentPoolCandidateRepository();
    const worlds = new InMemoryGameWorldRepository();
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
      0, // isolate expiry behavior from the generation batch for this test
    );

    const result = await useCase.execute({ worldId });

    expect(result.expired).toBe(1);
    expect((await candidates.findById(TalentPoolCandidateId('stale')))!.status).toBe('expired');
    expect((await candidates.findById(TalentPoolCandidateId('fresh')))!.status).toBe('available');
    // A candidate that was already claimed (not available) is never
    // touched by the expiry sweep, regardless of age.
    expect((await candidates.findById(TalentPoolCandidateId('claimed')))!.status).toBe('claimed');
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
    );

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});
