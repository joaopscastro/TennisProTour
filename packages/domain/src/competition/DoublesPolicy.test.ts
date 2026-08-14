import { describe, expect, it } from 'vitest';
import {
  hasDoublesQualifying,
  doublesQualifierSlotsFor,
  doublesQualifyingDrawSizeFor,
  doublesQualifyingRoundCountFor,
  doublesQualifyingPointsFor,
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

  it('pays only tiny points for doubles qualifying elimination', () => {
    expect(doublesQualifyingPointsFor(0)).toBe(0);
    expect(doublesQualifyingPointsFor(1)).toBe(1);
    expect(doublesQualifyingPointsFor(2)).toBe(3);
  });
});
