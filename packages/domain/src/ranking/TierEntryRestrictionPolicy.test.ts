import { describe, expect, it } from 'vitest';
import {
  CHALLENGER_MAX_RANK,
  FUTURES_MAX_RANK,
  isRankTooHighForTier,
  maxSeniorRankForTier,
  seniorTierEntryRestrictionReason,
} from './TierEntryRestrictionPolicy';

describe('TierEntryRestrictionPolicy', () => {
  it('blocks a top-200 player from futures but leaves challenger/tour/major open', () => {
    expect(isRankTooHighForTier('futures', 200)).toBe(true);
    expect(isRankTooHighForTier('futures', 1)).toBe(true);
    expect(isRankTooHighForTier('challenger', 200)).toBe(false);
    expect(isRankTooHighForTier('tour', 1)).toBe(false);
    expect(isRankTooHighForTier('major', 1)).toBe(false);
  });

  it('blocks a top-50 player from challenger but leaves tour/major open', () => {
    expect(isRankTooHighForTier('challenger', CHALLENGER_MAX_RANK)).toBe(true);
    expect(isRankTooHighForTier('challenger', 1)).toBe(true);
    expect(isRankTooHighForTier('tour', 1)).toBe(false);
    expect(isRankTooHighForTier('major', 1)).toBe(false);
  });

  it('allows a player ranked just outside each cutoff', () => {
    expect(isRankTooHighForTier('futures', FUTURES_MAX_RANK + 1)).toBe(false);
    expect(isRankTooHighForTier('challenger', CHALLENGER_MAX_RANK + 1)).toBe(false);
  });

  it('never blocks an unranked player from any tier', () => {
    for (const tier of ['futures', 'challenger', 'tour', 'major', 'j30', 'j500', 'juniorMasters'] as const) {
      expect(isRankTooHighForTier(tier, null)).toBe(false);
    }
  });

  it('never restricts a junior tier — this is a senior-tour rule', () => {
    for (const tier of ['j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'] as const) {
      expect(maxSeniorRankForTier(tier)).toBeNull();
      expect(isRankTooHighForTier(tier, 1)).toBe(false);
    }
  });

  it('exposes the placeholder cutoffs and a specific refusal reason', () => {
    expect(maxSeniorRankForTier('futures')).toBe(FUTURES_MAX_RANK);
    expect(maxSeniorRankForTier('challenger')).toBe(CHALLENGER_MAX_RANK);
    expect(seniorTierEntryRestrictionReason('futures', 87)).toBe(
      'ranked #87 on the senior ladder — too high to enter a futures event',
    );
    expect(seniorTierEntryRestrictionReason('futures', null)).toBeNull();
    expect(seniorTierEntryRestrictionReason('tour', 1)).toBeNull();
  });
});
