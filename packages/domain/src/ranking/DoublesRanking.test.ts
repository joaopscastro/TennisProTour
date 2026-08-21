import { describe, expect, it } from 'vitest';
import { DOUBLES_BEST_RESULTS_CAP, doublesEntryRanking, doublesPrizeMoneyFor } from './DoublesRanking';

describe('doublesEntryRanking', () => {
  it('uses the doubles ranking when a player has one', () => {
    expect(doublesEntryRanking(120, 40)).toBe(120);
  });

  it('falls back to the singles ranking when the doubles ranking is zero', () => {
    expect(doublesEntryRanking(0, 40)).toBe(40);
    expect(doublesEntryRanking(0, 0)).toBe(0);
  });

  it('exposes RR\'s best-14 cap for the doubles ranking', () => {
    expect(DOUBLES_BEST_RESULTS_CAP).toBe(14);
  });
});

describe('doublesPrizeMoneyFor', () => {
  it('pays SOMETHING for a first-round loss at a senior tier — unlike points, real ATP rule 3.08.B.3 pays for any match played', () => {
    expect(doublesPrizeMoneyFor('major', 0)).toBeGreaterThan(0);
  });

  it('pays the champion round strictly more than a first-round loss', () => {
    expect(doublesPrizeMoneyFor('major', 6)).toBeGreaterThan(doublesPrizeMoneyFor('major', 0));
    expect(doublesPrizeMoneyFor('tour', 5)).toBeGreaterThan(doublesPrizeMoneyFor('tour', 0));
  });

  it('pays nothing at a junior tier — no fallback to a singles-scaled amount, unlike doublesPointsFor', () => {
    expect(doublesPrizeMoneyFor('j100', 0)).toBe(0);
    expect(doublesPrizeMoneyFor('j100', 5)).toBe(0);
  });
});
