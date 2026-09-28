import { describe, expect, it } from 'vitest';
import {
  CHALLENGER_MAX_RANK,
  CHALLENGER_SEASON_ENTRY_CAP,
  FUTURES_MAX_RANK,
  isInsideSoftCapCutoff,
  isRankTooHighForTier,
  maxSeniorRankForTier,
  seasonSoftCapRefusalReason,
  seniorTierEntryRestrictionReason,
  softCapCutoffForTier,
  softSeasonCapForTier,
  tierUsesSeniorRank,
} from './TierEntryRestrictionPolicy';

describe('TierEntryRestrictionPolicy — hard bar (futures, unchanged)', () => {
  it('blocks a top-200 player from futures but leaves challenger/tour/major open at the hard bar', () => {
    expect(isRankTooHighForTier('futures', 200)).toBe(true);
    expect(isRankTooHighForTier('futures', 1)).toBe(true);
    // The challenger hard bar is GONE (Batch 4B): a top player may enter
    // challenger, subject only to the per-season soft cap below.
    expect(isRankTooHighForTier('challenger', 1)).toBe(false);
    expect(isRankTooHighForTier('challenger', 200)).toBe(false);
    expect(isRankTooHighForTier('tour', 1)).toBe(false);
    expect(isRankTooHighForTier('major', 1)).toBe(false);
  });

  it('allows a player ranked just outside the futures cutoff', () => {
    expect(isRankTooHighForTier('futures', FUTURES_MAX_RANK + 1)).toBe(false);
  });

  it('never blocks an unranked player from any tier', () => {
    for (const tier of ['futures', 'challenger', 'tour', 'major', 'j30', 'j500', 'juniorMasters'] as const) {
      expect(isRankTooHighForTier(tier, null)).toBe(false);
      expect(isInsideSoftCapCutoff(tier, null)).toBe(false);
    }
  });

  it('never restricts a junior tier — this is a senior-tour rule', () => {
    for (const tier of ['j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'] as const) {
      expect(maxSeniorRankForTier(tier)).toBeNull();
      expect(softSeasonCapForTier(tier)).toBeNull();
      expect(softCapCutoffForTier(tier)).toBeNull();
      expect(tierUsesSeniorRank(tier)).toBe(false);
      expect(isRankTooHighForTier(tier, 1)).toBe(false);
    }
  });

  it('exposes the placeholder hard cutoff and a specific refusal reason', () => {
    expect(maxSeniorRankForTier('futures')).toBe(FUTURES_MAX_RANK);
    expect(maxSeniorRankForTier('challenger')).toBeNull();
    expect(seniorTierEntryRestrictionReason('futures', 87)).toBe(
      'ranked #87 on the senior ladder — too high to enter a futures event',
    );
    expect(seniorTierEntryRestrictionReason('futures', null)).toBeNull();
    expect(seniorTierEntryRestrictionReason('tour', 1)).toBeNull();
    // No hard-bar reason for a challenger rank anymore — that refusal is
    // the season cap's, built by seasonSoftCapRefusalReason.
    expect(seniorTierEntryRestrictionReason('challenger', 1)).toBeNull();
  });
});

describe('TierEntryRestrictionPolicy — challenger per-season soft cap (Batch 4B)', () => {
  it('exposes the placeholder cap and cutoff, and marks both restricted tiers as rank-reading', () => {
    expect(softSeasonCapForTier('challenger')).toBe(CHALLENGER_SEASON_ENTRY_CAP);
    expect(softCapCutoffForTier('challenger')).toBe(CHALLENGER_MAX_RANK);
    expect(softSeasonCapForTier('futures')).toBeNull();
    expect(softSeasonCapForTier('tour')).toBeNull();
    expect(tierUsesSeniorRank('futures')).toBe(true);
    expect(tierUsesSeniorRank('challenger')).toBe(true);
    expect(tierUsesSeniorRank('tour')).toBe(false);
    expect(tierUsesSeniorRank('major')).toBe(false);
  });

  it('applies only to ranks inside the cutoff — rank 50 is in, rank 51 is out', () => {
    expect(isInsideSoftCapCutoff('challenger', CHALLENGER_MAX_RANK)).toBe(true);
    expect(isInsideSoftCapCutoff('challenger', 1)).toBe(true);
    expect(isInsideSoftCapCutoff('challenger', CHALLENGER_MAX_RANK + 1)).toBe(false);
    expect(isInsideSoftCapCutoff('futures', 1)).toBe(false);
  });

  it('allows a soft-capped player under the cap and refuses with a plain reason once it is used', () => {
    // Under the cap: no reason yet, however close.
    expect(seasonSoftCapRefusalReason('challenger', 50, 0)).toBeNull();
    expect(seasonSoftCapRefusalReason('challenger', 50, CHALLENGER_SEASON_ENTRY_CAP - 1)).toBeNull();
    // At/over the cap: refused, in the one shared phrasing.
    expect(seasonSoftCapRefusalReason('challenger', 50, CHALLENGER_SEASON_ENTRY_CAP)).toBe(
      'ranked #50 on the senior ladder — top-50 players may enter 3 challenger events per season, and all 3 are used',
    );
    expect(seasonSoftCapRefusalReason('challenger', 1, 99)).toContain('all 3 are used');
  });

  it('never builds a soft-cap reason for an outside-cutoff, unranked, or uncapped tier', () => {
    expect(seasonSoftCapRefusalReason('challenger', 51, 99)).toBeNull();
    expect(seasonSoftCapRefusalReason('challenger', null, 99)).toBeNull();
    expect(seasonSoftCapRefusalReason('tour', 1, 99)).toBeNull();
    expect(seasonSoftCapRefusalReason('futures', 201, 99)).toBeNull();
  });
});
