import { describe, expect, it } from 'vitest';
import { StandardPracticePolicy } from './PracticePolicy';

/**
 * The bounded-practice ladder cap (season-4 balance fix). Measured
 * before it: up to 7 × 15 = 105 ladder/week/player with no competitive
 * trade-off; after: at most 3 × 15 = 45, while development XP and the
 * fatigue cost are untouched so practice keeps its real training role.
 */
describe('StandardPracticePolicy — the bounded weekly ladder credit', () => {
  const policy = new StandardPracticePolicy();

  it('banks full ladder for the first 3 sessions of a week and nothing after', () => {
    expect(policy.ladderSessionsPerWeek()).toBe(3);
    expect(policy.ladderPointsForSession(0)).toBe(15);
    expect(policy.ladderPointsForSession(1)).toBe(15);
    expect(policy.ladderPointsForSession(2)).toBe(15);
    expect(policy.ladderPointsForSession(3)).toBe(0);
    // Seven sessions is the day-clock maximum (one per day).
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => policy.ladderPointsForSession(n)).reduce((a, b) => a + b, 0)).toBe(45);
  });

  it('leaves the development-XP and fatigue roles untouched', () => {
    expect(policy.practiceExperience()).toBe(2);
    expect(policy.practiceFatigue()).toBe(2);
  });

  it('never rewards a negative session index (defensive: an unknown week counts as the first session)', () => {
    expect(policy.ladderPointsForSession(-1)).toBe(15);
  });
});
