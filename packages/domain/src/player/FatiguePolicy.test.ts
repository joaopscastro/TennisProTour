import { describe, it, expect } from 'vitest';
import { fatigueCostForMatch, BASE_MATCH_FATIGUE, MAX_STAMINA_FATIGUE_RESISTANCE } from './FatiguePolicy';

describe('fatigueCostForMatch', () => {
  it('charges the full base cost to a zero-stamina player', () => {
    expect(fatigueCostForMatch(0)).toBe(BASE_MATCH_FATIGUE);
  });

  it('charges the minimum (fully resisted) cost to a max-stamina player', () => {
    const expected = Math.round(BASE_MATCH_FATIGUE * (1 - MAX_STAMINA_FATIGUE_RESISTANCE));
    expect(fatigueCostForMatch(100)).toBe(expected);
    expect(fatigueCostForMatch(100)).toBeLessThan(BASE_MATCH_FATIGUE);
  });

  it('is monotonically non-increasing in stamina', () => {
    let prev = fatigueCostForMatch(0);
    for (let s = 1; s <= 100; s++) {
      const cost = fatigueCostForMatch(s);
      expect(cost).toBeLessThanOrEqual(prev);
      prev = cost;
    }
  });

  it('clamps out-of-range stamina to [0, 100]', () => {
    expect(fatigueCostForMatch(-50)).toBe(fatigueCostForMatch(0));
    expect(fatigueCostForMatch(500)).toBe(fatigueCostForMatch(100));
  });
});
