import { describe, expect, it } from 'vitest';
import { GameWeek } from '../shared/ids';
import { addWeeks, weeksBetween } from './GameWorld';

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
