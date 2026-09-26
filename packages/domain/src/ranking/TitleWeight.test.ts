import { describe, it, expect } from 'vitest';
import { ALL_TOURNAMENT_TIERS, StandardRankingPointsTable } from '../competition/CompetitionTypes';
import { summarizeTitleTiers, titleWeightFor } from './TitleWeight';

describe('titleWeightFor', () => {
  it('reads the champion value straight off StandardRankingPointsTable — no duplicated constant', () => {
    const table = new StandardRankingPointsTable();
    expect(titleWeightFor('major')).toBe(2000);
    expect(titleWeightFor('tour')).toBe(1000);
    expect(titleWeightFor('challenger')).toBe(500);
    expect(titleWeightFor('futures')).toBe(250);
    expect(titleWeightFor('j500')).toBe(500);
    expect(titleWeightFor('j30')).toBe(30);
    // For EVERY tier, the weight is exactly the table's own champion value
    // (index 7 after its clamping) — the single-source-of-truth property.
    for (const tier of ALL_TOURNAMENT_TIERS) {
      expect(titleWeightFor(tier)).toBe(table.pointsFor(tier, 7));
    }
  });

  it('keeps the tier ordering real: a major outweighs every smaller title even combined', () => {
    expect(titleWeightFor('major')).toBeGreaterThan(titleWeightFor('j500') * 2);
    expect(titleWeightFor('major')).toBeGreaterThan(titleWeightFor('futures'));
  });
});

describe('summarizeTitleTiers', () => {
  it('returns the raw count AND the tier-weighted total together, with a per-tier breakdown', () => {
    expect(summarizeTitleTiers(['j60', 'j60', 'j60', 'major'])).toEqual({
      count: 4,
      weight: 3 * 60 + 2000,
      byTier: { j60: 3, major: 1 },
    });
  });

  it('is a zero tally for a player with no titles', () => {
    expect(summarizeTitleTiers([])).toEqual({ count: 0, weight: 0, byTier: {} });
  });
});
