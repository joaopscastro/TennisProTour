import { describe, expect, it } from 'vitest';
import { StandardTalentClaimPricingPolicy } from './TalentClaimPricingPolicy';

describe('StandardTalentClaimPricingPolicy', () => {
  const policy = new StandardTalentClaimPricingPolicy();

  it('prices strictly higher ratings strictly higher', () => {
    expect(policy.priceFor(70)).toBeGreaterThan(policy.priceFor(50));
    expect(policy.priceFor(90)).toBeGreaterThan(policy.priceFor(70));
  });

  it('scales super-linearly: doubling the rating more than doubles the price', () => {
    const priceAt25 = policy.priceFor(25);
    const priceAt50 = policy.priceFor(50);
    expect(priceAt50).toBeGreaterThan(priceAt25 * 2);
  });

  it('never prices below zero, even for a degenerate zero/negative rating', () => {
    expect(policy.priceFor(0)).toBe(0);
    expect(policy.priceFor(-10)).toBe(0);
  });
});
