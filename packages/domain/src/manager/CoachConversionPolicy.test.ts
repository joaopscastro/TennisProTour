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

  describe('cost/rating cap alignment', () => {
    it('two different players who both hit the coachRating cap have IDENTICAL conversion cost, regardless of how far past the threshold they are', () => {
      // Player A: barely past the cap-triggering threshold.
      const justPastCap = { overall: 100, age: 27 * WEEKS_PER_SEASON };
      // Player B: absurdly, unrealistically far past it — both in age
      // and via a completely different overall/age mix.
      const wayPastCap = { overall: 100, age: 1000 * WEEKS_PER_SEASON };
      // Player C: a third, differently-shaped combination (much lower
      // overall, made up for by far more age) that ALSO saturates the
      // cap — proving the plateau isn't tied to one particular path.
      const differentPathToCap = { overall: 20, age: 500 * WEEKS_PER_SEASON };

      expect(policy.coachRatingFor(justPastCap.overall, justPastCap.age)).toBe(100);
      expect(policy.coachRatingFor(wayPastCap.overall, wayPastCap.age)).toBe(100);
      expect(policy.coachRatingFor(differentPathToCap.overall, differentPathToCap.age)).toBe(100);

      const costA = policy.conversionCostFor(justPastCap.overall, justPastCap.age);
      const costB = policy.conversionCostFor(wayPastCap.overall, wayPastCap.age);
      const costC = policy.conversionCostFor(differentPathToCap.overall, differentPathToCap.age);

      expect(costB).toBe(costA);
      expect(costC).toBe(costA);
    });

    it('conversion cost never decreases once a player crosses into the saturated (coachRating-capped) zone', () => {
      // Just below the cap-triggering threshold vs. just at/past it —
      // cost should be non-decreasing across that boundary, not drop.
      const justBelow = { overall: 100, age: 26 * WEEKS_PER_SEASON }; // rating < 100
      const justAtOrPast = { overall: 100, age: 27 * WEEKS_PER_SEASON }; // rating >= 100

      expect(policy.coachRatingFor(justBelow.overall, justBelow.age)).toBeLessThan(100);
      expect(policy.coachRatingFor(justAtOrPast.overall, justAtOrPast.age)).toBe(100);

      const costJustBelow = policy.conversionCostFor(justBelow.overall, justBelow.age);
      const costJustAtOrPast = policy.conversionCostFor(justAtOrPast.overall, justAtOrPast.age);
      expect(costJustAtOrPast).toBeGreaterThanOrEqual(costJustBelow);
    });

    it('conversion cost strictly increases with age/ability right up until the coachRating cap, then stops', () => {
      const belowCapLow = policy.conversionCostFor(60, 10 * WEEKS_PER_SEASON);
      const belowCapHigh = policy.conversionCostFor(60, 20 * WEEKS_PER_SEASON);
      expect(belowCapHigh).toBeGreaterThan(belowCapLow); // still climbing pre-cap

      const atCap = policy.conversionCostFor(100, 27 * WEEKS_PER_SEASON);
      const wayPastCap = policy.conversionCostFor(100, 500 * WEEKS_PER_SEASON);
      expect(wayPastCap).toBe(atCap); // flat once saturated — no further climb
    });
  });
});
