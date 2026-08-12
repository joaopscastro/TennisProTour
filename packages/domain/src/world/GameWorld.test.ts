import { describe, expect, it } from 'vitest';
import { GameWeek, WorldId } from '../shared/ids';
import { addDays, addWeeks, daysBetween, GameDay, GameWorld, weeksBetween } from './GameWorld';

describe('addWeeks', () => {
  it('advances within the same season when the season boundary is not crossed', () => {
    expect(addWeeks({ season: 1, week: 2 }, 1)).toEqual({ season: 1, week: 3 });
    expect(addWeeks({ season: 1, week: 2 }, 3)).toEqual({ season: 1, week: 5 });
  });

  it('rolls over into the next season past week 52, exactly like GameWorld.advanceWeek does one week at a time', () => {
    expect(addWeeks({ season: 1, week: 52 }, 1)).toEqual({ season: 2, week: 1 });
    expect(addWeeks({ season: 1, week: 50 }, 3)).toEqual({ season: 2, week: 1 });
    expect(addWeeks({ season: 1, week: 50 }, 4)).toEqual({ season: 2, week: 2 });
  });

  it('handles a delta spanning multiple full seasons', () => {
    expect(addWeeks({ season: 1, week: 1 }, 52)).toEqual({ season: 2, week: 1 });
    expect(addWeeks({ season: 1, week: 1 }, 104)).toEqual({ season: 3, week: 1 });
  });

  it('a delta of 0 returns the same week', () => {
    expect(addWeeks({ season: 3, week: 17 }, 0)).toEqual({ season: 3, week: 17 });
  });

  it('supports a negative delta, rolling backward across a season boundary', () => {
    expect(addWeeks({ season: 2, week: 1 }, -1)).toEqual({ season: 1, week: 52 });
  });

  it('is the exact inverse of weeksBetween for every week in this test\'s range', () => {
    const weeks: GameWeek[] = [
      { season: 0, week: 1 },
      { season: 1, week: 1 },
      { season: 1, week: 30 },
      { season: 4, week: 52 },
    ];
    for (const week of weeks) {
      for (const delta of [0, 1, 5, 12, 52, -1, -10]) {
        const shifted = addWeeks(week, delta);
        expect(weeksBetween(week, shifted)).toBe(delta);
      }
    }
  });
});

describe('day arithmetic', () => {
  it('daysBetween counts days within and across week boundaries', () => {
    expect(daysBetween({ season: 1, week: 1, day: 1 }, { season: 1, week: 1, day: 4 })).toBe(3);
    expect(daysBetween({ season: 1, week: 1, day: 7 }, { season: 1, week: 2, day: 1 })).toBe(1);
    expect(daysBetween({ season: 1, week: 1, day: 1 }, { season: 1, week: 2, day: 1 })).toBe(7);
  });

  it('daysBetween counts across a season boundary', () => {
    expect(daysBetween({ season: 1, week: 52, day: 7 }, { season: 2, week: 1, day: 1 })).toBe(1);
  });

  it('addDays rolls day, week and season the same way advanceDay does one day at a time', () => {
    expect(addDays({ season: 1, week: 1, day: 6 }, 1)).toEqual({ season: 1, week: 1, day: 7 });
    expect(addDays({ season: 1, week: 1, day: 7 }, 1)).toEqual({ season: 1, week: 2, day: 1 });
    expect(addDays({ season: 1, week: 52, day: 7 }, 1)).toEqual({ season: 2, week: 1, day: 1 });
    expect(addDays({ season: 1, week: 1, day: 1 }, 7)).toEqual({ season: 1, week: 2, day: 1 });
  });

  it('addDays supports negative deltas across boundaries', () => {
    expect(addDays({ season: 2, week: 1, day: 1 }, -1)).toEqual({ season: 1, week: 52, day: 7 });
  });

  it('is the exact inverse of daysBetween across its range', () => {
    const points: GameDay[] = [
      { season: 0, week: 1, day: 1 },
      { season: 1, week: 1, day: 4 },
      { season: 1, week: 30, day: 7 },
      { season: 4, week: 52, day: 2 },
    ];
    for (const point of points) {
      for (const delta of [0, 1, 6, 7, 8, 364, -1, -13]) {
        expect(daysBetween(point, addDays(point, delta))).toBe(delta);
      }
    }
  });
});

describe('GameWorld.advanceDay', () => {
  it('advances one day without rolling the week for days 1..6', () => {
    const world = GameWorld.create(WorldId('w'), { season: 1, week: 1 });
    expect(world.currentDay).toBe(1);
    const r = world.advanceDay('t1');
    expect(r).toEqual({ advanced: true, weekRolledOver: false });
    expect(world.currentDay).toBe(2);
    expect(world.currentWeek).toEqual({ season: 1, week: 1 });
  });

  it('rolls the week over (and resets day to 1) advancing past day 7', () => {
    const world = GameWorld.create(WorldId('w'), { season: 1, week: 1 });
    let last;
    for (let i = 1; i <= 6; i++) last = world.advanceDay(`t${i}`);
    expect(world.currentDay).toBe(7);
    expect(last).toEqual({ advanced: true, weekRolledOver: false });
    const rollover = world.advanceDay('t7');
    expect(rollover).toEqual({ advanced: true, weekRolledOver: true });
    expect(world.currentDay).toBe(1);
    expect(world.currentWeek).toEqual({ season: 1, week: 2 });
  });

  it('is idempotent on a repeated tick key', () => {
    const world = GameWorld.create(WorldId('w'), { season: 1, week: 1 });
    world.advanceDay('same');
    const repeat = world.advanceDay('same');
    expect(repeat).toEqual({ advanced: false, weekRolledOver: false });
    expect(world.currentDay).toBe(2);
  });

  it('rolls the season over at week 52 day 7', () => {
    const world = GameWorld.reconstitute({
      id: WorldId('w'),
      currentWeek: { season: 1, week: 52 },
      currentDay: 7,
      lastAppliedTick: null,
    });
    const r = world.advanceDay('t');
    expect(r.weekRolledOver).toBe(true);
    expect(world.currentWeek).toEqual({ season: 2, week: 1 });
    expect(world.currentDay).toBe(1);
  });
});
