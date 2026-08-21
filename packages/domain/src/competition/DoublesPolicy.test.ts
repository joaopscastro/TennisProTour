import { describe, expect, it } from 'vitest';
import {
  hasDoublesQualifying,
  doublesQualifierSlotsFor,
  doublesQualifyingDrawSizeFor,
  doublesQualifyingRoundCountFor,
  doublesQualifyingPointsFor,
  doublesQualifyingPrizeMoneyFor,
} from './DoublesPolicy';

describe('doubles qualifying (draw-size-derived)', () => {
  it('holds no qualifying for a small doubles draw', () => {
    expect(hasDoublesQualifying(8)).toBe(false);
    expect(doublesQualifierSlotsFor(8)).toBe(0);
    expect(doublesQualifyingDrawSizeFor(8)).toBe(0);
    expect(doublesQualifyingRoundCountFor(8)).toBe(0);
  });

  it('reserves 1/8 of a big enough draw for qualifiers (a 16-pair draw → 2 slots)', () => {
    expect(hasDoublesQualifying(16)).toBe(true);
    expect(doublesQualifierSlotsFor(16)).toBe(2);
    expect(doublesQualifyingDrawSizeFor(16)).toBe(8); // 4 pairs per slot
    expect(doublesQualifyingRoundCountFor(16)).toBe(2); // log2(4)
  });

  it('scales with draw size (a 32-pair draw → 4 slots)', () => {
    expect(doublesQualifierSlotsFor(32)).toBe(4);
    expect(doublesQualifyingDrawSizeFor(32)).toBe(16);
  });

  it('pays the real, sourced doubles qualifying points (2026 PIF ATP Rankings 9.02.G.6: 25 for a final-qualifying-round loss)', () => {
    expect(doublesQualifyingPointsFor(0)).toBe(0); // lost round 1 — no points in the first round, ever
    expect(doublesQualifyingPointsFor(1)).toBe(25); // lost the final (and only other) qualifying round
    expect(doublesQualifyingPointsFor(2)).toBe(25); // clamps — there is no round beyond the final one
  });

  it('pays SOMETHING for losing round 1 of doubles qualifying — unlike points, real ATP rule 3.08.B.3 pays for any match played', () => {
    expect(doublesQualifyingPrizeMoneyFor(0)).toBeGreaterThan(0);
    expect(doublesQualifyingPrizeMoneyFor(1)).toBeGreaterThan(doublesQualifyingPrizeMoneyFor(0));
    expect(doublesQualifyingPrizeMoneyFor(2)).toBe(doublesQualifyingPrizeMoneyFor(1)); // clamps
  });
});
