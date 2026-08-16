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
import { EnsureFillOnlyPopulationUseCase, FILL_ONLY_FLOORS } from './EnsureFillOnlyPopulationUseCase';

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
    return `filler-${this.counter}`;
  }
}

const realRandom: RandomSource = { next: () => Math.random() };
const agingPolicy = new StandardAgingPolicy();
const generationPolicy = new StandardPlayerGenerationPolicy();

function makeFiller(id: string, ageInWeeks: number): Player {
  const g = generationPolicy.generate(realRandom, { minWeeks: ageInWeeks, maxWeeks: ageInWeeks });
  return Player.generateFillOnly(
    PlayerId(id),
    `Filler ${id}`,
    g.ageInWeeks,
    agingPolicy.stageForAge(g.ageInWeeks),
    g.attributes,
    'US',
    g.potentialCeiling,
    g.physicalCeilings,
    g.talent,
  );
}

async function setup(worldId: WorldId = WorldId('main')) {
  const worlds = new InMemoryGameWorldRepository();
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  const useCase = new EnsureFillOnlyPopulationUseCase(worlds, players, events, generationPolicy, realRandom, new SequentialIdGenerator(), agingPolicy);
  return { worlds, players, events, worldId, useCase };
}

describe('EnsureFillOnlyPopulationUseCase', () => {
  it('generates the full floor when starting from zero, every one fillOnly with no manager', async () => {
    const { players, worldId, useCase } = await setup();
    const totalFloor = FILL_ONLY_FLOORS.reduce((sum, f) => sum + f.minimum, 0);

    const result = await useCase.execute({ worldId });

    expect(result.generated).toBe(totalFloor);
    expect(players.all()).toHaveLength(totalFloor);
    expect(players.all().every((p) => p.fillOnly)).toBe(true);
    expect(players.all().every((p) => p.managerId === null)).toBe(true);
  });

  it('meets each band floor and every generated age maps into its band', async () => {
    const { players, worldId, useCase } = await setup();
    await useCase.execute({ worldId });

    const byBand = new Map<string, number>();
    for (const p of players.all()) {
      const band = juniorEligibilityForAge(p.ageInWeeks);
      byBand.set(band, (byBand.get(band) ?? 0) + 1);
    }
    for (const floor of FILL_ONLY_FLOORS) {
      expect(byBand.get(floor.band) ?? 0).toBeGreaterThanOrEqual(floor.minimum);
    }
  });

  it('is idempotent — a re-run generates nothing once floors are met', async () => {
    const { players, worldId, useCase } = await setup();
    await useCase.execute({ worldId });
    const firstCount = players.all().length;

    const second = await useCase.execute({ worldId });

    expect(second.generated).toBe(0);
    expect(players.all().length).toBe(firstCount);
  });

  it('only generates the SHORTFALL, not the whole floor, when a band is partially populated', async () => {
    const { players, worldId, useCase } = await setup();
    for (let i = 0; i < 10; i++) {
      await players.save(makeFiller(`existing-${i}`, 25 * 52)); // 10 senior-age fillers
    }

    const result = await useCase.execute({ worldId });

    // 10 seniors already exist -> senior shortfall is 200 - 10 = 190;
    // the u16 (40) and u14 (10) bands still generate their full floor.
    const expected = 190 + FILL_ONLY_FLOORS[1].minimum + FILL_ONLY_FLOORS[2].minimum;
    expect(result.generated).toBe(expected);
  });

  it('throws when the target game world does not exist', async () => {
    const { useCase } = await setup();

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});
