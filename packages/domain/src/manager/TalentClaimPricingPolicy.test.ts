import { describe, expect, it } from 'vitest';
import { AgeRange } from '../player/PlayerGenerationPolicy';
import { StandardTalentClaimPricingPolicy } from './TalentClaimPricingPolicy';

// Mirrors TALENT_POOL_AGE_RANGE's actual span (14-16yo) without
// importing it — packages/domain cannot depend on packages/application
// (hexagonal boundary), and this policy doesn't care what the real
// call-site range is anyway, only that SOME range with real width is
// supplied, same as PlayerGenerationPolicy's own tests define their
// own local AgeRange fixtures.
const RANGE: AgeRange = { minWeeks: 14 * 52, maxWeeks: 16 * 52 - 1 };
const YOUNGEST = RANGE.minWeeks;
const OLDEST = RANGE.maxWeeks;
const MIDDLE = (RANGE.minWeeks + RANGE.maxWeeks) / 2;

describe('StandardTalentClaimPricingPolicy', () => {
  const policy = new StandardTalentClaimPricingPolicy();

  describe('at the youngest generated age — near-flat, ability barely matters', () => {
    it('prices a weak and a strong candidate the same', () => {
      const weak = policy.priceFor(25, YOUNGEST, RANGE);
      const strong = policy.priceFor(90, YOUNGEST, RANGE);
      expect(weak).toBe(strong);
    });

    it('prices at exactly BASE_COST (50) regardless of rating', () => {
      expect(policy.priceFor(0, YOUNGEST, RANGE)).toBe(50);
      expect(policy.priceFor(50, YOUNGEST, RANGE)).toBe(50);
      expect(policy.priceFor(99, YOUNGEST, RANGE)).toBe(50);
    });
  });

  describe('at the oldest generated age — fully ability-based, matching the original unblended formula', () => {
    it('prices strictly higher ratings strictly higher', () => {
      expect(policy.priceFor(70, OLDEST, RANGE)).toBeGreaterThan(policy.priceFor(50, OLDEST, RANGE));
      expect(policy.priceFor(90, OLDEST, RANGE)).toBeGreaterThan(policy.priceFor(70, OLDEST, RANGE));
    });

    it('scales super-linearly: doubling the rating more than doubles the price', () => {
      const priceAt25 = policy.priceFor(25, OLDEST, RANGE);
      const priceAt50 = policy.priceFor(50, OLDEST, RANGE);
      expect(priceAt50).toBeGreaterThan(priceAt25 * 2);
    });

    it('never prices below zero, even for a degenerate zero/negative rating', () => {
      expect(policy.priceFor(0, OLDEST, RANGE)).toBe(0);
      expect(policy.priceFor(-10, OLDEST, RANGE)).toBe(0);
    });
  });

  describe('blending across age, reusing PlayerGenerationPolicy.ageInterpolationFactor', () => {
    it('a strong candidate gets MORE expensive as generated age increases toward the oldest', () => {
      const strong = 85;
      const priceYoung = policy.priceFor(strong, YOUNGEST, RANGE);
      const priceMiddle = policy.priceFor(strong, MIDDLE, RANGE);
      const priceOld = policy.priceFor(strong, OLDEST, RANGE);
      expect(priceMiddle).toBeGreaterThan(priceYoung);
      expect(priceOld).toBeGreaterThan(priceMiddle);
    });

    it('a weak candidate gets CHEAPER as generated age increases toward the oldest — ability-based pricing works both directions, not just "older = pricier"', () => {
      const weak = 15;
      const priceYoung = policy.priceFor(weak, YOUNGEST, RANGE);
      const priceMiddle = policy.priceFor(weak, MIDDLE, RANGE);
      const priceOld = policy.priceFor(weak, OLDEST, RANGE);
      expect(priceMiddle).toBeLessThan(priceYoung);
      expect(priceOld).toBeLessThan(priceMiddle);
    });

    it('a middle-age price sits between the flat and fully-ability-based prices, for both a weak and a strong candidate', () => {
      for (const rating of [15, 85]) {
        const flat = policy.priceFor(rating, YOUNGEST, RANGE);
        const middle = policy.priceFor(rating, MIDDLE, RANGE);
        const abilityBased = policy.priceFor(rating, OLDEST, RANGE);
        expect(middle).toBeGreaterThanOrEqual(Math.min(flat, abilityBased));
        expect(middle).toBeLessThanOrEqual(Math.max(flat, abilityBased));
      }
    });
  });
});
