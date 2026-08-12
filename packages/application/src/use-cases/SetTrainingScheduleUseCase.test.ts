import { describe, expect, it } from 'vitest';
import { GameWorld, ManagerId, Player, PlayerAttributes, PlayerId, Skill, SurfaceAffinities, TrainingFocus, TrainingScheduleEntry, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, TrainingScheduleRepository } from '../ports/ports';
import { SetTrainingScheduleUseCase } from './SetTrainingScheduleUseCase';

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

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

class InMemoryTrainingScheduleRepository implements TrainingScheduleRepository {
  readonly entries: TrainingScheduleEntry[] = [];

  async findByPlayer(playerId: PlayerId): Promise<TrainingScheduleEntry[]> {
    return this.entries.filter((e) => e.playerId === playerId);
  }

  async save(entry: TrainingScheduleEntry): Promise<void> {
    const i = this.entries.findIndex(
      (e) => e.playerId === entry.playerId && e.effectiveFrom.season === entry.effectiveFrom.season && e.effectiveFrom.week === entry.effectiveFrom.week,
    );
    if (i >= 0) this.entries[i] = entry;
    else this.entries.push(entry);
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

const WORLD_ID = WorldId('main');

async function setup() {
  const players = new InMemoryPlayerRepository();
  const schedule = new InMemoryTrainingScheduleRepository();
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.create(WORLD_ID, { season: 1, week: 5 }));
  const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
  await players.save(player);
  const useCase = new SetTrainingScheduleUseCase(players, schedule, worlds, WORLD_ID);
  return { players, schedule, worlds, useCase };
}

describe('SetTrainingScheduleUseCase', () => {
  it('records an entry effective from the world\'s current week when no week is given, without applying any attribute delta', async () => {
    const { schedule, useCase } = await setup();
    const focus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    const result = await useCase.execute({ playerId: PlayerId('p1'), focus });

    expect(result).toEqual({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 5 }, focus });
    expect(await schedule.findByPlayer(PlayerId('p1'))).toEqual([result]);
  });

  it('records an entry for an explicit future week', async () => {
    const { schedule, useCase } = await setup();
    const focus: TrainingFocus = { kind: 'attribute', attribute: 'serve' };

    await useCase.execute({ playerId: PlayerId('p1'), focus, effectiveFrom: { season: 1, week: 10 } });

    expect(await schedule.findByPlayer(PlayerId('p1'))).toEqual([
      { playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 10 }, focus },
    ]);
  });

  it('overwrites an existing entry for the same week rather than adding a second one', async () => {
    const { schedule, useCase } = await setup();
    const week = { season: 1, week: 10 };

    await useCase.execute({ playerId: PlayerId('p1'), focus: { kind: 'surface', surface: 'clay' }, effectiveFrom: week });
    await useCase.execute({ playerId: PlayerId('p1'), focus: { kind: 'surface', surface: 'grass' }, effectiveFrom: week });

    const entries = await schedule.findByPlayer(PlayerId('p1'));
    expect(entries).toHaveLength(1);
    expect(entries[0].focus).toEqual({ kind: 'surface', surface: 'grass' });
  });

  it('clears the standing order from a given week with an explicit null focus', async () => {
    const { schedule, useCase } = await setup();

    await useCase.execute({ playerId: PlayerId('p1'), focus: null });

    expect((await schedule.findByPlayer(PlayerId('p1')))[0].focus).toBeNull();
  });

  it('rejects scheduling a week strictly before the world\'s current week', async () => {
    const { useCase } = await setup(); // world is at season 1, week 5

    await expect(
      useCase.execute({ playerId: PlayerId('p1'), focus: { kind: 'surface', surface: 'clay' }, effectiveFrom: { season: 1, week: 4 } }),
    ).rejects.toThrow(/past week/);
  });

  it('allows scheduling exactly the current week (not just strictly future)', async () => {
    const { schedule, useCase } = await setup();

    await expect(
      useCase.execute({ playerId: PlayerId('p1'), focus: { kind: 'surface', surface: 'clay' }, effectiveFrom: { season: 1, week: 5 } }),
    ).resolves.not.toThrow();
    expect(await schedule.findByPlayer(PlayerId('p1'))).toHaveLength(1);
  });

  it('throws when the player does not exist', async () => {
    const { useCase } = await setup();

    await expect(
      useCase.execute({ playerId: PlayerId('ghost'), focus: { kind: 'surface', surface: 'clay' } }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when the player is retired, and does not persist any change', async () => {
    const { players, schedule, useCase } = await setup();
    const player = (await players.findById(PlayerId('p1')))!;
    player.advanceWeek(38 * 52, 'retired', startingAttributes());
    await players.save(player);

    await expect(
      useCase.execute({ playerId: PlayerId('p1'), focus: { kind: 'surface', surface: 'clay' } }),
    ).rejects.toThrow(/retired/);
    expect(await schedule.findByPlayer(PlayerId('p1'))).toEqual([]);
  });
});
