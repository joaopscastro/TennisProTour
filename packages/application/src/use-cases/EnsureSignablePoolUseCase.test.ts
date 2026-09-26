import { describe, expect, it } from 'vitest';
import {
  GameWorld,
  ManagerId,
  Player,
  PlayerId,
  RandomSource,
  StandardAgingPolicy,
  StandardPlayerGenerationPolicy,
  WorldId,
  juniorEligibilityForAge,
} from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';
import { MIN_SIGNABLE_FREE_AGENTS, EnsureSignablePoolUseCase } from './EnsureSignablePoolUseCase';

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

  /** The fake's stand-in for the real exact-predicate count: every
   * unowned, non-retired player it holds is signable. */
  async countSignableFreeAgents(): Promise<number> {
    return (await this.findFreeAgents()).length;
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
    return `signable-${this.counter}`;
  }
}

const realRandom: RandomSource = { next: () => Math.random() };
const agingPolicy = new StandardAgingPolicy();
const generationPolicy = new StandardPlayerGenerationPolicy();

async function setup(minimum?: number) {
  const worlds = new InMemoryGameWorldRepository();
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  const worldId = WorldId('main');
  await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  const useCase = new EnsureSignablePoolUseCase(
    worlds,
    players,
    events,
    generationPolicy,
    realRandom,
    new SequentialIdGenerator(),
    agingPolicy,
    minimum,
  );
  return { worlds, players, events, worldId, useCase };
}

describe('EnsureSignablePoolUseCase (D3 — the acquisition loop)', () => {
  it('generates the full floor when nothing is signable, as fillOnly free agents', async () => {
    const { players, worldId, useCase } = await setup();

    const result = await useCase.execute({ worldId });

    expect(result.signableBefore).toBe(0);
    expect(result.generated).toBe(MIN_SIGNABLE_FREE_AGENTS);
    expect(players.all()).toHaveLength(MIN_SIGNABLE_FREE_AGENTS);
    expect(players.all().every((p) => p.fillOnly && p.managerId === null)).toBe(true);
  });

  it('generates only the shortfall below the floor', async () => {
    const { players, worldId, useCase } = await setup();
    // 20 signable already: 5 short of the default 25.
    for (let i = 0; i < 20; i++) {
      players.save(
        Player.generateFillOnly(PlayerId(`existing-${i}`), `Existing ${i}`, 20 * 52, 'prime', generationPolicy.generate(realRandom, { minWeeks: 20 * 52, maxWeeks: 20 * 52 }).attributes, 'US', 60, { speed: 60, stamina: 60, strength: 60 }),
      );
    }

    const result = await useCase.execute({ worldId });

    expect(result.signableBefore).toBe(20);
    expect(result.generated).toBe(MIN_SIGNABLE_FREE_AGENTS - 20);
  });

  it('is a no-op when the pool already has enough signable free agents', async () => {
    const { players, worldId, useCase } = await setup();
    const g = generationPolicy.generate(realRandom, { minWeeks: 20 * 52, maxWeeks: 20 * 52 });
    for (let i = 0; i < MIN_SIGNABLE_FREE_AGENTS; i++) {
      players.save(
        Player.generateFillOnly(PlayerId(`enough-${i}`), `Enough ${i}`, 20 * 52, 'prime', g.attributes, 'US', 60, { speed: 60, stamina: 60, strength: 60 }),
      );
    }

    const result = await useCase.execute({ worldId });

    expect(result.signableBefore).toBe(MIN_SIGNABLE_FREE_AGENTS);
    expect(result.generated).toBe(0);
  });

  it('is idempotent — the second run generates nothing and the population is unchanged', async () => {
    const { players, worldId, useCase } = await setup();

    const first = await useCase.execute({ worldId });
    const countAfterFirst = players.all().length;
    const second = await useCase.execute({ worldId });

    expect(first.generated).toBe(MIN_SIGNABLE_FREE_AGENTS);
    expect(second.generated).toBe(0);
    expect(players.all()).toHaveLength(countAfterFirst);
  });

  it('spreads generation across the band ranges, so the pool is age-varied rather than one band', async () => {
    const { players, worldId, useCase } = await setup();

    await useCase.execute({ worldId });

    const bands = new Set(players.all().map((p) => juniorEligibilityForAge(p.seasonAgeAnchorWeeks)));
    expect(bands).toEqual(new Set(['senior', 'u18', 'u16', 'u14']));
  });

  it('throws when the target game world does not exist', async () => {
    const { useCase } = await setup();
    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});
