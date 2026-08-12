import { describe, it, expect } from 'vitest';
import { StandardTournamentSchedulePolicy, isTwoWeekTier } from './TournamentSchedulePolicy';

describe('isTwoWeekTier', () => {
  it('classifies major and juniorMasters as two-week tiers', () => {
    expect(isTwoWeekTier('major')).toBe(true);
    expect(isTwoWeekTier('juniorMasters')).toBe(true);
  });

  it('classifies every other tier as one-week', () => {
    for (const tier of ['futures', 'challenger', 'tour', 'j30', 'j60', 'j100', 'j200', 'j300', 'j500'] as const) {
      expect(isTwoWeekTier(tier)).toBe(false);
    }
  });
});

describe('StandardTournamentSchedulePolicy', () => {
  const policy = new StandardTournamentSchedulePolicy();

  it('one-week tiers play round r on day r', () => {
    // 32-draw = 5 rounds on days 1-5
    expect(policy.roundDay('challenger', 32, 1)).toBe(1);
    expect(policy.roundDay('challenger', 32, 5)).toBe(5);
    expect(policy.durationDays('challenger', 32)).toBe(5);
  });

  it('a 128-draw one-week tier fills exactly days 1-7', () => {
    expect(policy.roundDay('tour', 128, 7)).toBe(7);
    expect(policy.durationDays('tour', 128)).toBe(7);
  });

  it('two-week tiers spread rounds across up to 14 days', () => {
    // 128-draw major = 7 rounds over 14 days: ceil(r*14/7) = 2r
    expect(policy.roundDay('major', 128, 1)).toBe(2);
    expect(policy.roundDay('major', 128, 4)).toBe(8);
    expect(policy.roundDay('major', 128, 7)).toBe(14);
    expect(policy.durationDays('major', 128)).toBe(14);
  });

  it('a two-week final always lands on day 14', () => {
    for (const draw of [16, 32, 64, 128] as const) {
      expect(policy.durationDays('major', draw)).toBe(14);
    }
  });

  it('rounds are monotonically non-decreasing in scheduled day', () => {
    const rounds = Math.log2(128);
    let prev = 0;
    for (let r = 1; r <= rounds; r++) {
      const day = policy.roundDay('major', 128, r);
      expect(day).toBeGreaterThan(prev);
      prev = day;
    }
  });

  it('rejects an out-of-range round number', () => {
    expect(() => policy.roundDay('challenger', 32, 0)).toThrow();
    expect(() => policy.roundDay('challenger', 32, 6)).toThrow();
  });
});
