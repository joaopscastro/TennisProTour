import { expect, test } from '@playwright/test';
import { roundCollapsed, roundStatus } from '../lib/bracketStatus';
import { xpAffordability } from '../lib/xp';

/**
 * Pure-logic regression tests for two first-time-visitor bugs. These need
 * no browser/page — they run under the existing Playwright runner (the
 * web workspace has no separate unit runner) and assert the exact
 * computations the bracket and Scouting screens use.
 */

test.describe('bracket round status + collapse', () => {
  const decidedAired = { decided: true, airState: 'aired' as const };
  const decidedLive = { decided: true, airState: 'live' as const };
  const decidedUpcoming = { decided: true, airState: 'upcoming' as const };
  // An undecided match has no reveal window, so the air-state function
  // yields 'aired' for it — the exact reason the old logic mislabelled a
  // whole un-played round as Decided.
  const undecided = { decided: false, airState: 'aired' as const };

  test('an all-undecided generated round is Upcoming, never Decided', () => {
    expect(roundStatus(true, [undecided, undecided])).toBe('Upcoming');
    expect(roundCollapsed(true, [undecided, undecided])).toBe(false);
  });

  test('a partially played round is In progress and never collapses', () => {
    expect(roundStatus(true, [decidedAired, undecided])).toBe('In progress');
    expect(roundCollapsed(true, [decidedAired, undecided])).toBe(false);
  });

  test('a round is Decided only once every match is played AND aired', () => {
    expect(roundStatus(true, [decidedAired, decidedAired])).toBe('Decided');
    expect(roundCollapsed(true, [decidedAired, decidedAired])).toBe(true);
  });

  test('all played but not yet airing is Scheduled, not Airing', () => {
    expect(roundStatus(true, [decidedUpcoming, decidedUpcoming])).toBe('Scheduled');
    expect(roundCollapsed(true, [decidedUpcoming, decidedUpcoming])).toBe(false);
  });

  test('all played with a reveal in progress is Airing', () => {
    expect(roundStatus(true, [decidedAired, decidedLive])).toBe('Airing');
    expect(roundCollapsed(true, [decidedAired, decidedLive])).toBe(false);
  });

  test('a not-yet-generated round is Upcoming', () => {
    expect(roundStatus(false, [])).toBe('Upcoming');
    expect(roundCollapsed(false, [])).toBe(false);
  });
});

test.describe('XP affordability — unknown is not zero', () => {
  test('not-yet-loaded balance is unknown, not an assumed zero', () => {
    expect(xpAffordability(null, 50)).toEqual({ state: 'unknown' });
    expect(xpAffordability(undefined, 50)).toEqual({ state: 'unknown' });
  });

  test('a real zero balance is short, distinct from unknown', () => {
    expect(xpAffordability(0, 50)).toEqual({ state: 'short', remaining: 50 });
  });

  test('an exact or surplus balance is affordable', () => {
    expect(xpAffordability(50, 50)).toEqual({ state: 'affordable' });
    expect(xpAffordability(1500, 50)).toEqual({ state: 'affordable' });
  });
});
