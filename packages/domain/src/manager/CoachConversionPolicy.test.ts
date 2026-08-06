import { describe, expect, it } from 'vitest';
import { StandardCoachConversionPolicy } from './CoachConversionPolicy';
import { WEEKS_PER_SEASON } from '../world/GameWorld';

describe('StandardCoachConversionPolicy', () => {
  const policy = new StandardCoachConversionPolicy();

  it('produces a strictly higher coachRating for a more able player at the same age', () => {
    const age = 25 * WEEKS_PER_SEASON;
    expect(policy.coachRatingFor(80, age)).toBeGreaterThan(policy.coachRatingFor(40, age));
  });

  it('produces a strictly higher coachRating for an older player at the same ability', () => {
    const overall = 60;
    expect(policy.coachRatingFor(overall, 30 * WEEKS_PER_SEASON)).toBeGreaterThan(
      policy.coachRatingFor(overall, 20 * WEEKS_PER_SEASON),
    );
  });

  it('caps coachRating at 100 even for an extreme input', () => {
    expect(policy.coachRatingFor(100, 60 * WEEKS_PER_SEASON)).toBeLessThanOrEqual(100);
  });

  it('costs strictly more XP to convert a more able player at the same age', () => {
    const age = 25 * WEEKS_PER_SEASON;
    expect(policy.conversionCostFor(80, age)).toBeGreaterThan(policy.conversionCostFor(40, age));
  });

  it('costs strictly more XP to convert an older player at the same ability', () => {
    const overall = 60;
    expect(policy.conversionCostFor(overall, 30 * WEEKS_PER_SEASON)).toBeGreaterThan(
      policy.conversionCostFor(overall, 20 * WEEKS_PER_SEASON),
    );
  });

  it('has a nonzero base cost/rating even for a weak, young player', () => {
    expect(policy.conversionCostFor(0, 18 * WEEKS_PER_SEASON)).toBeGreaterThan(0);
    expect(policy.coachRatingFor(0, 18 * WEEKS_PER_SEASON)).toBeGreaterThan(0);
  });
});
