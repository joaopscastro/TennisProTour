import { expect, test } from '@playwright/test';
import { roundCollapsed, roundStatus, roundSubtitle } from '../lib/bracketStatus';
import {
  activeSetTag,
  championRevealed,
  hasAired,
  matchAirState,
  matchAirStateForDto,
  matchState,
  replayOverlayCopy,
  replayScoreVisible,
} from '../lib/matchAir';
import { nextPendingEntry } from '../lib/pendingEntry';
import type { PlannerWeekDto } from '../lib/api';
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
  // An undecided match has no result to reveal, so the air-state function
  // now reports 'upcoming' for it (never 'aired') — the exact reason the
  // old logic mislabelled a whole un-played round as Decided.
  const undecided = { decided: false, airState: 'upcoming' as const };

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

  test('a decided match with no schedule is aired; an undecided one is upcoming', () => {
    expect(matchAirState(decided(null), now)).toBe('aired');
    expect(hasAired(decided(null), now)).toBe(true);
    // An undecided match has no result to hide, so it is NOT "aired" —
    // it is simply upcoming (this is what stops a round being "Decided"
    // before anything has been played).
    expect(matchAirState({ decided: false, scheduledStartAt: '2026-01-01T13:00:00Z', revealSeconds: 900 }, now)).toBe('upcoming');
    expect(hasAired({ decided: false, scheduledStartAt: null, revealSeconds: 0 }, now)).toBe(false);
  });

  test('the DTO adapter applies the SAME predicate to every bracket draw', () => {
    // This is the adapter the qualifying panel, both doubles panels and the
    // replay now read — a decided-but-not-yet-aired DTO row must report
    // 'upcoming', not 'aired', or the bracket leaks a score the replay calls
    // "Premieres at …". The exact bug: a qualifying match rendered its
    // `outcome` directly while its replay correctly withheld it.
    const decidedDto = (scheduledStartAt: string | null, revealSeconds = 900) => ({
      outcome: { winner: 'a', loser: 'b', setScores: [] },
      scheduledStartAt,
      revealSeconds,
    });
    expect(matchAirStateForDto(decidedDto('2026-01-01T13:00:00Z'), now)).toBe('upcoming');
    expect(matchAirStateForDto(decidedDto('2026-01-01T11:55:00Z'), now)).toBe('live');
    expect(matchAirStateForDto(decidedDto('2026-01-01T11:00:00Z'), now)).toBe('aired');
    // An undecided row is upcoming; a decided row with no schedule is aired.
    expect(matchAirStateForDto({ outcome: null, scheduledStartAt: null }, now)).toBe('upcoming');
    expect(matchAirStateForDto(decidedDto(null), now)).toBe('aired');
  });
});

/**
 * The state matrix: the four combinations a match can be in, checked
 * against EVERY view that used to compute its own notion of "has this
 * aired". One row per state, one assertion per view, so a future change
 * that lets a view drift is caught here rather than in a walkthrough.
 *
 *   not-started    decided=false            -> upcoming
 *   live           decided, reveal running  -> live
 *   decided-unaired decided, reveal pending -> upcoming
 *   aired          decided, reveal elapsed  -> aired
 */
test.describe('match-state matrix — every view reads the one predicate', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const match = (decided: boolean, scheduledStartAt: string | null): { decided: boolean; scheduledStartAt: string | null; revealSeconds: number } => ({
    decided,
    scheduledStartAt,
    revealSeconds: 900,
  });

  const states = [
    { name: 'not started', m: match(false, null), expected: 'upcoming' as const },
    { name: 'live', m: match(true, '2026-01-01T11:55:00Z'), expected: 'live' as const },
    { name: 'decided but not aired', m: match(true, '2026-01-01T13:00:00Z'), expected: 'upcoming' as const },
    { name: 'aired', m: match(true, '2026-01-01T11:00:00Z'), expected: 'aired' as const },
  ];

  for (const { name, m, expected } of states) {
    test(`[${name}] the predicate, round header, champion gate, replay and set tag all agree`, () => {
      // 1. The one predicate.
      expect(matchState(m, now)).toBe(expected);
      expect(matchAirState(m, now)).toBe(expected);

      // 2. The bracket's round summary derives from the SAME state as its
      //    cards: a round is only "Decided"/collapsed when every match is
      //    played AND aired.
      const cards = [{ decided: m.decided, airState: expected }];
      const status = roundStatus(true, cards);
      const collapsed = roundCollapsed(true, cards);
      if (expected === 'aired') {
        expect(status).toBe('Decided');
        expect(collapsed).toBe(true);
      } else {
        expect(status).not.toBe('Decided');
        expect(collapsed).toBe(false);
      }

      // 3. The champion banner + title celebration are gated on AIRED, never
      //    merely decided.
      expect(championRevealed(m, now)).toBe(expected === 'aired');

      // 4. The replay overlay never claims "premiere" and "already decided"
      //    at once, and shows the final score only once aired.
      const overlay = replayOverlayCopy(expected, '2:00 PM');
      expect(overlay.headline).toContain(expected === 'aired' ? 'Aired' : expected === 'live' ? 'Premiering' : 'Premieres');
      expect(overlay.note.includes('already decided')).toBe(expected === 'aired');
      expect(replayScoreVisible(false, expected, false)).toBe(expected === 'aired');

      // 5. The set tag only says PREMIERE before the match airs.
      expect(activeSetTag(expected)).toBe(expected === 'upcoming' ? 'PREMIERE' : null);
    });
  }
});

test.describe('replay scoreboard — aired results show immediately', () => {
  test('an aired match shows its final score before playback starts', () => {
    // The reported contradiction: the overlay said "Aired … Result already
    // decided" while the scoreboard rendered "SET 1 – SET 2 –".
    expect(replayScoreVisible(false, 'aired', false)).toBe(true);
  });

  test('a pre-premiere match reveals nothing until it airs or finishes', () => {
    expect(replayScoreVisible(false, 'upcoming', false)).toBe(false);
    expect(replayScoreVisible(false, 'live', false)).toBe(false);
  });

  test('playback finishing always reveals the score, whatever the air state', () => {
    expect(replayScoreVisible(true, 'upcoming', true)).toBe(true);
    expect(replayScoreVisible(true, 'live', true)).toBe(true);
    expect(replayScoreVisible(true, 'aired', true)).toBe(true);
  });

  test('once playback starts, the scoreboard follows playback (not the air state)', () => {
    expect(replayScoreVisible(false, 'aired', true)).toBe(false);
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

test.describe('pending tournament entry (roster "what next")', () => {
  const week = (
    season: number,
    w: number,
    entries: Array<{ id: string; name: string; tier: string; hasStarted: boolean }>,
  ) => ({ week: { season, week: w }, entries }) as unknown as PlannerWeekDto;

  test('no planner or no entries means no pending entry', () => {
    expect(nextPendingEntry(null)).toBeNull();
    expect(nextPendingEntry(undefined)).toBeNull();
    expect(nextPendingEntry([week(1, 1, [])])).toBeNull();
  });

  test('picks the earliest not-yet-drawn entry and skips already-started ones', () => {
    const planner = [
      week(1, 1, [{ id: 'played', name: 'Already Started', tier: 'j30', hasStarted: true }]),
      week(1, 3, [{ id: 'open', name: 'Ireland Classic', tier: 'j30', hasStarted: false }]),
      week(1, 5, [{ id: 'later', name: 'Later Open', tier: 'j60', hasStarted: false }]),
    ];
    expect(nextPendingEntry(planner)).toEqual({
      tournamentId: 'open',
      name: 'Ireland Classic',
      tier: 'j30',
      week: { season: 1, week: 3 },
    });
  });

  test('a planner with only started events yields nothing (the match read takes over)', () => {
    expect(nextPendingEntry([week(1, 2, [{ id: 's', name: 'Started', tier: 'tour', hasStarted: true }])])).toBeNull();
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
