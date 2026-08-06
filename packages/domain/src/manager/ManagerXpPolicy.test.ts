import { describe, expect, it } from 'vitest';
import { StandardManagerXpPolicy } from './ManagerXpPolicy';

describe('StandardManagerXpPolicy', () => {
  const policy = new StandardManagerXpPolicy();

  it('awards more XP for a win than a loss at the same tier', () => {
    expect(policy.xpFor('win', 'challenger')).toBeGreaterThan(policy.xpFor('loss', 'challenger'));
  });

  it('awards strictly more XP at a higher tier for the same result, matching the ranking-points ordering', () => {
    const tiers = ['futures', 'challenger', 'tour', 'major'] as const;
    for (let i = 1; i < tiers.length; i++) {
      expect(policy.xpFor('loss', tiers[i])).toBeGreaterThan(policy.xpFor('loss', tiers[i - 1]));
      expect(policy.xpFor('win', tiers[i])).toBeGreaterThan(policy.xpFor('win', tiers[i - 1]));
    }
  });

  it('awards strictly more XP for a higher junior grade, and keeps the whole junior ladder below futures', () => {
    const juniorTiers = ['j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'] as const;
    for (let i = 1; i < juniorTiers.length; i++) {
      expect(policy.xpFor('loss', juniorTiers[i])).toBeGreaterThan(policy.xpFor('loss', juniorTiers[i - 1]));
    }
    expect(policy.xpFor('loss', 'juniorMasters')).toBeLessThan(policy.xpFor('loss', 'futures'));
  });

  it('awards some XP for a loss (participation has value), not zero', () => {
    expect(policy.xpFor('loss', 'j30')).toBeGreaterThan(0);
  });
});
