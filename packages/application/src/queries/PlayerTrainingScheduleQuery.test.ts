import { describe, expect, it } from 'vitest';
import { GameWorld, PlayerId, TrainingScheduleEntry, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, TrainingScheduleRepository } from '../ports/ports';
import { PlayerTrainingScheduleQuery } from './PlayerTrainingScheduleQuery';

class InMemoryTrainingScheduleRepository implements TrainingScheduleRepository {
  private readonly entries: TrainingScheduleEntry[] = [];

  async findByPlayer(playerId: PlayerId): Promise<TrainingScheduleEntry[]> {
    return this.entries.filter((e) => e.playerId === playerId);
  }

  async save(entry: TrainingScheduleEntry): Promise<void> {
    this.entries.push(entry);
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

const worldId = WorldId('main');

describe('PlayerTrainingScheduleQuery', () => {
  it('returns one week per slot in the window, all null/not-explicit when no entry has ever been set', async () => {
    const schedule = new InMemoryTrainingScheduleRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
    const query = new PlayerTrainingScheduleQuery(schedule, worlds);

    const result = await query.forPlayer(worldId, PlayerId('p1'), 4);

    expect(result.map((r) => r.week)).toEqual([
      { season: 1, week: 1 },
      { season: 1, week: 2 },
      { season: 1, week: 3 },
      { season: 1, week: 4 },
    ]);
    for (const r of result) {
      expect(r.focus).toBeNull();
      expect(r.isExplicit).toBe(false);
    }
  });

  it('marks only the week an explicit entry was set for as isExplicit, and carries the focus forward through the rest of the window', async () => {
    const schedule = new InMemoryTrainingScheduleRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
    await schedule.save({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 2 }, focus: { kind: 'surface', surface: 'clay' } });
    const query = new PlayerTrainingScheduleQuery(schedule, worlds);

    const result = await query.forPlayer(worldId, PlayerId('p1'), 4);

    expect(result[0]).toEqual({ week: { season: 1, week: 1 }, focus: null, isExplicit: false });
    expect(result[1]).toEqual({ week: { season: 1, week: 2 }, focus: { kind: 'surface', surface: 'clay' }, isExplicit: true });
    expect(result[2]).toEqual({ week: { season: 1, week: 3 }, focus: { kind: 'surface', surface: 'clay' }, isExplicit: false });
    expect(result[3]).toEqual({ week: { season: 1, week: 4 }, focus: { kind: 'surface', surface: 'clay' }, isExplicit: false });
  });

  it('a future entry beyond the window does not appear, but doesn\'t break resolution for weeks inside the window either', async () => {
    const schedule = new InMemoryTrainingScheduleRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
    await schedule.save({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'attribute', attribute: 'serve' } });
    await schedule.save({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 50 }, focus: { kind: 'surface', surface: 'grass' } });
    const query = new PlayerTrainingScheduleQuery(schedule, worlds);

    const result = await query.forPlayer(worldId, PlayerId('p1'), 3);

    for (const r of result) expect(r.focus).toEqual({ kind: 'attribute', attribute: 'serve' });
  });

  it('does not include another player\'s schedule entries', async () => {
    const schedule = new InMemoryTrainingScheduleRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
    await schedule.save({ playerId: PlayerId('someone-else'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'clay' } });
    const query = new PlayerTrainingScheduleQuery(schedule, worlds);

    const result = await query.forPlayer(worldId, PlayerId('p1'), 2);
    for (const r of result) expect(r.focus).toBeNull();
  });

  it('rolls across a season boundary correctly (reuses addWeeks)', async () => {
    const schedule = new InMemoryTrainingScheduleRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 51 }, lastAppliedTick: null }));
    const query = new PlayerTrainingScheduleQuery(schedule, worlds);

    const result = await query.forPlayer(worldId, PlayerId('p1'), 4);
    expect(result.map((r) => r.week)).toEqual([
      { season: 1, week: 51 },
      { season: 1, week: 52 },
      { season: 2, week: 1 },
      { season: 2, week: 2 },
    ]);
  });

  it('throws for an unknown world, same as other queries', async () => {
    const schedule = new InMemoryTrainingScheduleRepository();
    const worlds = new InMemoryGameWorldRepository();
    const query = new PlayerTrainingScheduleQuery(schedule, worlds);
    await expect(query.forPlayer(WorldId('nope'), PlayerId('p1'))).rejects.toThrow(/not found/);
  });
});
