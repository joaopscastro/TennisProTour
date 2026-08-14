import { describe, expect, it } from 'vitest';
import { DOUBLES_BEST_RESULTS_CAP, doublesEntryRanking } from './DoublesRanking';

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
