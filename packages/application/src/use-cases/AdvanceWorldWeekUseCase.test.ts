import { describe, expect, it } from 'vitest';
import {
  GameWorld,
  ManagerId,
  Player,
  PlayerAgingService,
  PlayerAttributes,
  PlayerId,
  Skill,
  StandardAgingPolicy,
  SurfaceAffinities,
  WorldId,
} from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, PlayerRepository } from '../ports/ports';
import { AdvanceWorldWeekUseCase } from './AdvanceWorldWeekUseCase';

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
  saveCount = 0;

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
    this.saveCount += 1;
    this.store.set(player.id, player);
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
  }
}

function startingAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(30), forehand: Skill.of(30), backhand: Skill.of(30), volley: Skill.of(30) },
    physical: { speed: Skill.of(30), stamina: Skill.of(30), strength: Skill.of(30) },
    mental: { consistency: Skill.of(30), clutch: Skill.of(30) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

async function setup(playerCount: number) {
  const worlds = new InMemoryGameWorldRepository();
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  const worldId = WorldId('main');
  await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  for (let i = 1; i <= playerCount; i++) {
    const player = Player.hire(PlayerId(`p${i}`), `Player ${i}`, 25 * 52, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    await players.save(player);
  }
  players.saveCount = 0;
  const useCase = new AdvanceWorldWeekUseCase(worlds, players, new PlayerAgingService(new StandardAgingPolicy()), events);
  return { worlds, players, events, worldId, useCase };
}

describe('AdvanceWorldWeekUseCase', () => {
  it('advances the world one week and ages every player', async () => {
    const { worlds, players, worldId, useCase } = await setup(3);

    const result = await useCase.execute({ worldId, tickKey: '2026-W31' });

    expect(result).toEqual({ advanced: true, playersAged: 3 });
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 2 });
    for (const player of await players.findAll()) {
      expect(player.ageInWeeks).toBe(25 * 52 + 1);
    }
  });

  it('is a no-op when run twice for the same tick', async () => {
    const { worlds, players, worldId, useCase } = await setup(3);

    const first = await useCase.execute({ worldId, tickKey: '2026-W31' });
    const savesAfterFirst = players.saveCount;
    const second = await useCase.execute({ worldId, tickKey: '2026-W31' });

    expect(first.advanced).toBe(true);
    expect(second).toEqual({ advanced: false, playersAged: 0 });
    // No player was touched or saved again, and the clock stayed put.
    expect(players.saveCount).toBe(savesAfterFirst);
    for (const player of await players.findAll()) {
      expect(player.ageInWeeks).toBe(25 * 52 + 1);
    }
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 2 });
  });

  it('advances again for a NEW tick key (the guard is per-tick, not once-ever)', async () => {
    const { worlds, worldId, useCase } = await setup(1);

    await useCase.execute({ worldId, tickKey: '2026-W31' });
    const result = await useCase.execute({ worldId, tickKey: '2026-W32' });

    expect(result.advanced).toBe(true);
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 3 });
  });

  it('rolls the season over after week 52', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 52 }));
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      new InMemoryPlayerRepository(),
      new PlayerAgingService(new StandardAgingPolicy()),
      new RecordingEventPublisher(),
    );

    await useCase.execute({ worldId, tickKey: 'tick' });

    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 2, week: 1 });
  });

  it('publishes PlayerRetired when the weekly advance tips a player into retirement', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const player = Player.hire(PlayerId('old'), 'Old Timer', 38 * 52 - 1, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    await players.save(player);
    const useCase = new AdvanceWorldWeekUseCase(worlds, players, new PlayerAgingService(new StandardAgingPolicy()), events);

    await useCase.execute({ worldId, tickKey: 'tick' });

    expect((await players.findById(PlayerId('old')))!.stage).toBe('retired');
    expect(events.published.some((e) => e.type === 'PlayerRetired')).toBe(true);
  });
});
