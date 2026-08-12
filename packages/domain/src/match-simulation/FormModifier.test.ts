import { describe, it, expect } from 'vitest';
import {
  formModifier,
  FORM_SWEET_SPOT_MIN,
  FORM_SWEET_SPOT_MAX,
  FORM_RUSTY_THRESHOLD,
  FORM_STALE_THRESHOLD,
  FORM_SWEET_SPOT_BONUS,
} from './StatisticalMatchSimulator';

describe('formModifier', () => {
  it('gives a flat bonus across the whole sweet-spot band', () => {
    for (let f = FORM_SWEET_SPOT_MIN; f <= FORM_SWEET_SPOT_MAX; f++) {
      expect(formModifier(f)).toBe(FORM_SWEET_SPOT_BONUS);
    }
  });

  it('applies no effect in the tolerance zone between thresholds and the bonus band', () => {
    // Below the sweet spot but not yet rusty.
    for (let f = FORM_RUSTY_THRESHOLD; f < FORM_SWEET_SPOT_MIN; f++) {
      expect(formModifier(f)).toBe(0);
    }
    // Above the sweet spot but not yet stale.
    for (let f = FORM_SWEET_SPOT_MAX + 1; f <= FORM_STALE_THRESHOLD; f++) {
      expect(formModifier(f)).toBe(0);
    }
  });

  it('penalises an under-played (rusty) player, worse the lower the form', () => {
    expect(formModifier(FORM_RUSTY_THRESHOLD - 1)).toBeLessThan(0);
    expect(formModifier(0)).toBeLessThan(formModifier(FORM_RUSTY_THRESHOLD - 1));
  });

  it('penalises an over-played (stale) player, worse the higher the form', () => {
    expect(formModifier(FORM_STALE_THRESHOLD + 1)).toBeLessThan(0);
    expect(formModifier(60)).toBeLessThan(formModifier(FORM_STALE_THRESHOLD + 1));
  });
});
