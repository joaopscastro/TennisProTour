import { expect, test } from '@playwright/test';
import { roundCollapsed, roundStatus, roundSubtitle } from '../lib/bracketStatus';
import { hasAired, matchAirState } from '../lib/matchAir';
import { xpAffordability } from '../lib/xp';
import { RANK_BAND_LABEL, rankingBandScopeNote } from '../lib/format';

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

  test('the subtitle agrees with the cards: decided-but-not-yet-aired never claims all played', () => {
    // The exact contradiction reported: header "8 of 8 played" while cards
    // still read "Starts in 0:14".
    expect(roundSubtitle(true, [decidedUpcoming, decidedUpcoming])).toBe('All played — results air shortly');
    expect(roundSubtitle(true, [decidedUpcoming, decidedUpcoming])).not.toMatch(/\d+ of \d+ played/);
    // Mixed: one aired, one still to start -> "1 of 2 results revealed", so
    // the header can never say every card is done while a card says otherwise.
    expect(roundSubtitle(true, [decidedAired, decidedUpcoming])).toBe('1 of 2 results revealed');
    expect(roundSubtitle(true, [decidedAired, decidedLive])).toBe('2 of 2 results revealed');
    // Once everything has aired the count is the plain "played" total again.
    expect(roundSubtitle(true, [decidedAired, decidedAired])).toBe('2 of 2 played');
    expect(roundSubtitle(true, [undecided, undecided])).toBe('2 matches scheduled');
  });
});

test.describe('match air state (one predicate for bracket + replay)', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const decided = (scheduledStartAt: string | null, revealSeconds = 900) => ({
    decided: true,
    scheduledStartAt,
    revealSeconds,
  });

  test('an aired match is past its reveal window', () => {
    expect(matchAirState(decided('2026-01-01T11:00:00Z'), now)).toBe('aired');
    expect(hasAired(decided('2026-01-01T11:00:00Z'), now)).toBe(true);
  });

  test('a decided match before its premiere is upcoming, not aired', () => {
    expect(matchAirState(decided('2026-01-01T13:00:00Z'), now)).toBe('upcoming');
    expect(hasAired(decided('2026-01-01T13:00:00Z'), now)).toBe(false);
  });

  test('a decided match inside its reveal window is live', () => {
    expect(matchAirState(decided('2026-01-01T11:55:00Z'), now)).toBe('live');
    expect(hasAired(decided('2026-01-01T11:55:00Z'), now)).toBe(false);
  });

  test('a match with no schedule or no outcome is treated as aired (nothing to hide)', () => {
    expect(matchAirState(decided(null), now)).toBe('aired');
    expect(matchAirState({ decided: false, scheduledStartAt: '2026-01-01T13:00:00Z', revealSeconds: 900 }, now)).toBe('aired');
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

test.describe('rank bands are always labelled', () => {
  test('every band has a distinct label, including Senior', () => {
    expect(RANK_BAND_LABEL).toEqual({ senior: 'Senior', u14: 'U14', u16: 'U16', u18: 'U18' });
  });

  test('a junior-band scope note names the band and says other bands do not count', () => {
    expect(rankingBandScopeNote('u16')).toContain('U16');
    expect(rankingBandScopeNote('u16')).toContain("don't");
  });

  test('the senior scope note is about senior results specifically', () => {
    expect(rankingBandScopeNote('senior')).toContain('senior-tour');
  });
});
