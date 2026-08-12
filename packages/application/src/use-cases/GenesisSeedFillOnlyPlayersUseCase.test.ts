import { describe, expect, it } from 'vitest';
import { GameWorld, ManagerId, Player, PlayerId, RandomSource, StandardPlayerGenerationPolicy, WorldId } from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';
import { GENESIS_AGE_RANGE, GenesisSeedFillOnlyPlayersUseCase } from './GenesisSeedFillOnlyPlayersUseCase';

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

  async findFreeAgents(): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === null && !p.isRetired());
  }

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }

  all(): Player[] {
    return [...this.store.values()];
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
    return `genesis-${this.counter}`;
  }
}

/** True pseudo-random, not the domain's own tests' Math.random() reuse
 * pattern for reproducibility — this specific suite needs a real
 * spread across many draws, and a fixed seed isn't available on
 * RandomSource, so Math.random() (same as RefreshTalentPoolUseCase's
 * own "wires the REAL StandardPlayerGenerationPolicy" test) is the
 * established precedent for this kind of distribution assertion. */
const realRandom: RandomSource = { next: () => Math.random() };

async function setup(worldId: WorldId = WorldId('main')) {
  const worlds = new InMemoryGameWorldRepository();
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  const useCase = new GenesisSeedFillOnlyPlayersUseCase(
    worlds,
    players,
    events,
    new StandardPlayerGenerationPolicy(),
    realRandom,
    new SequentialIdGenerator(),
  );
  return { worlds, players, events, worldId, useCase };
}

describe('GenesisSeedFillOnlyPlayersUseCase', () => {
  it('generates the requested population, every one fillOnly with no manager', async () => {
    const { players, worldId, useCase } = await setup();

    const result = await useCase.execute({ worldId, population: 40 });

    expect(result).toEqual({ generated: 40 });
    expect(players.all()).toHaveLength(40);
    expect(players.all().every((p) => p.fillOnly)).toBe(true);
    expect(players.all().every((p) => p.managerId === null)).toBe(true);
  });

  it('publishes a FillOnlyPlayerGenerated event per player, not PlayerHired', async () => {
    const { events, worldId, useCase } = await setup();

    await useCase.execute({ worldId, population: 5 });

    expect(events.published).toHaveLength(5);
    expect(events.published.every((e) => e.type === 'FillOnlyPlayerGenerated')).toBe(true);
  });

  it('defaults to GENESIS_POPULATION when no population override is given', async () => {
    const { players, worldId, useCase } = await setup();

    const result = await useCase.execute({ worldId });

    expect(result.generated).toBe(players.all().length);
    expect(result.generated).toBeGreaterThan(0);
  });

  it('produces ages across the REAL wide GENESIS_AGE_RANGE (14-37yo), not clustered near one age — the entire point of a genesis seed', async () => {
    const { players, worldId, useCase } = await setup();

    await useCase.execute({ worldId, population: 300 });

    const ages = players.all().map((p) => p.ageInWeeks);
    for (const age of ages) {
      expect(age).toBeGreaterThanOrEqual(GENESIS_AGE_RANGE.minWeeks);
      expect(age).toBeLessThanOrEqual(GENESIS_AGE_RANGE.maxWeeks);
    }

    // A real spread, not a clustered pile: every decade-ish bucket
    // across the 14-37yo span has at least one player. With 300 draws
    // uniformly across ~24 years, a fully-empty multi-year bucket would
    // indicate clustering, not genuine chance.
    const bucketOf = (ageInWeeks: number) => Math.floor(ageInWeeks / 52 / 6); // ~6-year buckets: 14-19, 20-25, 26-31, 32-37
    const bucketsHit = new Set(ages.map(bucketOf));
    expect(bucketsHit.size).toBeGreaterThanOrEqual(4); // all four ~6-year buckets represented

    // Confirms real dispersion, not "min and max happen to be wide but
    // everything else piles up in the middle": the spread (max - min)
    // should cover most of the available range.
    const spread = Math.max(...ages) - Math.min(...ages);
    const fullRange = GENESIS_AGE_RANGE.maxWeeks - GENESIS_AGE_RANGE.minWeeks;
    expect(spread).toBeGreaterThan(fullRange * 0.8);
  });

  it('computes each player’s lifecycle stage from their REAL rolled age, spanning youth/prime/decline (never retired, by construction)', async () => {
    const { players, worldId, useCase } = await setup();

    await useCase.execute({ worldId, population: 300 });

    const stages = new Set(players.all().map((p) => p.stage));
    expect(stages.has('retired')).toBe(false);
    // With 300 draws uniformly across 14-37yo (youth <20, prime 20-30,
    // decline 30-38), all three non-retired stages should appear.
    expect(stages.has('youth')).toBe(true);
    expect(stages.has('prime')).toBe(true);
    expect(stages.has('decline')).toBe(true);
  });

  it('throws when the target game world does not exist', async () => {
    const { useCase } = await setup();

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});
