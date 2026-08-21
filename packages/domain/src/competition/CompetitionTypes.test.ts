import { describe, expect, it } from 'vitest';
import {
  ALL_TOURNAMENT_TIERS,
  isJuniorTier,
  isUnsourcedPlaceholderTier,
  JUNIOR_TIER_VALUES,
  SENIOR_TIER_VALUES,
  StandardPrizeMoneyTable,
  StandardRankingPointsTable,
} from './CompetitionTypes';

describe('StandardRankingPointsTable', () => {
  const table = new StandardRankingPointsTable();

  it('returns 0 for roundsWon = 0 at every tier, senior and junior alike — a first-round loss earns nothing', () => {
    for (const tier of ALL_TOURNAMENT_TIERS) {
      expect(table.pointsFor(tier, 0)).toBe(0);
    }
  });

  it('previously returned full base points for a first-round loss at every pre-existing senior tier — regression guard for the fixed bug', () => {
    // Explicit per-tier assertions (not just the loop above) so this
    // regression is impossible to miss: the old formula was
    // basePoints * 1.6^roundsWon, which at roundsWon=0 collapsed to
    // basePoints — a full award for losing round 1 — at every tier
    // that existed before the junior work, not just new ones.
    expect(table.pointsFor('major', 0)).toBe(0);
    expect(table.pointsFor('tour', 0)).toBe(0);
    expect(table.pointsFor('challenger', 0)).toBe(0);
    expect(table.pointsFor('futures', 0)).toBe(0);
  });

  it('still awards positive points for an actual win (roundsWon >= 1) at every tier — the fix only zeroes round 0', () => {
    for (const tier of ALL_TOURNAMENT_TIERS) {
      expect(table.pointsFor(tier, 1)).toBeGreaterThan(0);
    }
  });

  it('wires the six real, sourced ITF champion values correctly at full roundsWon', () => {
    expect(table.pointsFor('j30', 7)).toBe(30);
    expect(table.pointsFor('j60', 7)).toBe(60);
    expect(table.pointsFor('j100', 7)).toBe(100);
    expect(table.pointsFor('j200', 7)).toBe(200);
    expect(table.pointsFor('j300', 7)).toBe(300);
    expect(table.pointsFor('j500', 7)).toBe(500);
  });

  it('clamps an out-of-range roundsWon the same way for a junior tier as for a senior one', () => {
    // roundsWon beyond the table's max index (7) clamps to the
    // champion value, same behavior the senior tiers already relied
    // on (see pointsFor's Math.min/Math.max clamp).
    expect(table.pointsFor('j500', 99)).toBe(table.pointsFor('j500', 7));
    expect(table.pointsFor('major', 99)).toBe(table.pointsFor('major', 7));
  });

  it('flags juniorMasters, and only juniorMasters, as an unsourced placeholder — not equally authoritative to the six real J-grades', () => {
    expect(isUnsourcedPlaceholderTier('juniorMasters')).toBe(true);

    const realJuniorGrades = JUNIOR_TIER_VALUES.filter((tier) => tier !== 'juniorMasters');
    expect(realJuniorGrades).toEqual(['j30', 'j60', 'j100', 'j200', 'j300', 'j500']);
    for (const tier of realJuniorGrades) {
      expect(isUnsourcedPlaceholderTier(tier)).toBe(false);
    }
    for (const tier of ['major', 'tour', 'challenger', 'futures'] as const) {
      expect(isUnsourcedPlaceholderTier(tier)).toBe(false);
    }
  });

  it("juniorMasters' placeholder champion value sits above the real J500 value, without pretending to be a sourced number", () => {
    expect(table.pointsFor('juniorMasters', 7)).toBeGreaterThan(table.pointsFor('j500', 7));
  });
});

describe('StandardPrizeMoneyTable', () => {
  const table = new StandardPrizeMoneyTable();

  it('pays SOMETHING for a first-round loss (roundsWon = 0) at every senior tier — unlike ranking points, real ATP rule 3.08.B.3 pays for any match played', () => {
    for (const tier of SENIOR_TIER_VALUES) {
      expect(table.prizeMoneyFor(tier, 0)).toBeGreaterThan(0);
    }
  });

  it('pays zero at every junior tier, at every round including the champion — real ITF juniors do not pay meaningful cash prize money', () => {
    for (const tier of JUNIOR_TIER_VALUES) {
      for (let roundsWon = 0; roundsWon <= 7; roundsWon++) {
        expect(table.prizeMoneyFor(tier, roundsWon)).toBe(0);
      }
    }
  });

  it('pays the champion (highest roundsWon) strictly more than every earlier round, at every senior tier', () => {
    for (const tier of SENIOR_TIER_VALUES) {
      let previous = -1;
      for (let roundsWon = 0; roundsWon <= 7; roundsWon++) {
        const money = table.prizeMoneyFor(tier, roundsWon);
        expect(money).toBeGreaterThanOrEqual(previous);
        previous = money;
      }
    }
  });

  it('clamps an out-of-range roundsWon to the champion value', () => {
    expect(table.prizeMoneyFor('major', 99)).toBe(table.prizeMoneyFor('major', 7));
  });
});

describe('isJuniorTier', () => {
  it('is true for exactly the seven junior-ladder tiers', () => {
    for (const tier of JUNIOR_TIER_VALUES) {
      expect(isJuniorTier(tier)).toBe(true);
    }
  });

  it('is false for every senior tier', () => {
    for (const tier of ['futures', 'challenger', 'tour', 'major'] as const) {
      expect(isJuniorTier(tier)).toBe(false);
    }
  });
});
