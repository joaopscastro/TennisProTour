import { describe, expect, it } from 'vitest';
import { bestResultsCapFor, juniorEligibilityForAge, matchesRankingBand } from './RankingBand';

describe('juniorEligibilityForAge', () => {
  it('is u14 for any age under 14 years', () => {
    expect(juniorEligibilityForAge(0)).toBe('u14');
    expect(juniorEligibilityForAge(14 * 52 - 1)).toBe('u14');
  });

  it('is u16 from exactly 14 years up to (not including) 16 years', () => {
    expect(juniorEligibilityForAge(14 * 52)).toBe('u16');
    expect(juniorEligibilityForAge(16 * 52 - 1)).toBe('u16');
  });

  it('is senior from exactly 16 years onward', () => {
    expect(juniorEligibilityForAge(16 * 52)).toBe('senior');
    expect(juniorEligibilityForAge(40 * 52)).toBe('senior');
  });

  it('a single one-week tick can only ever move eligibility to the immediately next band, never skip one', () => {
    // The two boundaries are 104 weeks apart, so this is really just
    // confirming the boundaries themselves are consistent, but it's
    // the exact invariant AdvanceWorldWeekUseCase's before/after
    // comparison relies on to detect "a" crossing without needing to
    // figure out which one.
    for (let age = 0; age < 20 * 52; age++) {
      const before = juniorEligibilityForAge(age);
      const after = juniorEligibilityForAge(age + 1);
      if (before !== after) {
        const order = ['u14', 'u16', 'senior'];
        expect(order.indexOf(after)).toBe(order.indexOf(before) + 1);
      }
    }
  });
});

describe('matchesRankingBand / bestResultsCapFor (sanity — full coverage lives in RankPositionQuery.test.ts)', () => {
  it('senior matches only a null ageBand', () => {
    expect(matchesRankingBand(null, 'senior')).toBe(true);
    expect(matchesRankingBand('u14', 'senior')).toBe(false);
  });

  it('caps at 6 for either junior band, 18 for senior', () => {
    expect(bestResultsCapFor('u14')).toBe(6);
    expect(bestResultsCapFor('u16')).toBe(6);
    expect(bestResultsCapFor('senior')).toBe(18);
  });
});
