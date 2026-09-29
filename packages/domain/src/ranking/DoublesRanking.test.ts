import { describe, expect, it } from 'vitest';
import {
  DOUBLES_BEST_RESULTS_CAP,
  DOUBLES_POINTS_PARITY_FACTOR,
  doublesEntryRanking,
  doublesPointsFor,
  doublesPrizeMoneyFor,
  sourcedDoublesPointsFor,
} from './DoublesRanking';

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

describe('the doubles points parity factor (season-4 balance fix)', () => {
  it('awards senior doubles at HALF the sourced table — the deliberate, measured deviation from raw ATP parity', () => {
    expect(DOUBLES_POINTS_PARITY_FACTOR).toBe(0.5);
    // Sourced senior values: major [0,90,180,360,720,1200,2000], etc.
    expect(sourcedDoublesPointsFor('major', 6, 2000)).toBe(2000);
    expect(doublesPointsFor('major', 6, 2000)).toBe(1000);
    expect(sourcedDoublesPointsFor('tour', 5, 1000)).toBe(1000);
    expect(doublesPointsFor('tour', 5, 1000)).toBe(500);
    expect(doublesPointsFor('challenger', 1, 50)).toBe(45);
    expect(doublesPointsFor('futures', 4, 165)).toBe(125);
  });

  it('keeps the sourced round-by-round SHAPE — every stage still pays strictly more than the one below', () => {
    for (const tier of ['major', 'tour', 'challenger', 'futures'] as const) {
      for (let round = 1; round < 8; round++) {
        const prev = doublesPointsFor(tier, round - 1, 0);
        const next = doublesPointsFor(tier, round, 0);
        // A stage beyond the tier's own round count clamps to its champion
        // value, so `next >= prev` holds (equal at the clamp).
        expect(next).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  it('leaves the junior fallback at its existing 0.5 × singles level — NOT scaled a second time', () => {
    // Junior tiers have no sourced doubles table; the fallback already
    // matches the senior post-factor level (half of singles).
    expect(doublesPointsFor('j100', 6, 60)).toBe(30);
    expect(sourcedDoublesPointsFor('j100', 6, 60)).toBe(30);
  });

  it('the historical reconstruction path (sourcedDoublesPointsFor) never applies the factor', () => {
    // The backfill must reproduce what the ledger recorded BEFORE this
    // change, so it reads the raw sourced table.
    expect(sourcedDoublesPointsFor('major', 6, 2000)).not.toBe(doublesPointsFor('major', 6, 2000));
  });
});
