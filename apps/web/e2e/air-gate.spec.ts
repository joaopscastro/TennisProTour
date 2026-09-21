import { expect, Page, test } from '@playwright/test';

/**
 * Browser regression tests for two bugs a third round of naive first-time-user
 * walkthroughs found — both variants of things already reported fixed:
 *
 *  1. The shared "has this match aired" predicate covered the MAIN bracket and
 *     the replay, but NOT the qualifying/doubles panels. A decided-but-not-yet-
 *     aired QUALIFYING match rendered its score in the bracket ("X def. Y 6-2,
 *     6-1") while its own replay page still said "Premieres at …". Every draw
 *     now goes through `matchAirStateForDto` (lib/matchAir).
 *  2. A manual "Simulate" button (the admin/dev override) was visible on the
 *     player-facing bracket. It is gone; the route is admin-gated server-side
 *     (covered by api.integration.test.ts).
 *
 * The API is mocked, so this runs under the default (non-live) Playwright
 * config with just the web dev server.
 */

const tournamentId = 'air-open';
const NOW = Date.now();
const future = new Date(NOW + 60 * 60 * 1000).toISOString();
const past = new Date(NOW - 60 * 60 * 1000).toISOString();

const outcome = (winner: string, loser: string, scores: Array<[number, number]>) => ({
  winner,
  loser,
  setScores: scores.map(([winnerGames, loserGames]) => ({ winnerGames, loserGames })),
});

const tournament = {
  id: tournamentId,
  name: 'Airgate Open',
  tier: 'challenger',
  circuit: 'senior',
  ageBand: null,
  surface: 'clay',
  hostCountry: null,
  pointsBreakdown: [
    { matchesWon: 3, stageLabel: 'Champion', points: 90 },
    { matchesWon: 0, stageLabel: 'Round of 16', points: 0 },
  ],
  prizeMoneyBreakdown: [
    { matchesWon: 3, stageLabel: 'Champion', prizeMoney: 100000 },
    { matchesWon: 0, stageLabel: 'Round of 16', prizeMoney: 1000 },
  ],
  pointsArePlaceholder: false,
  weekScheduled: { season: 1, week: 3 },
  drawSize: 8,
  mainDrawEntrants: 0,
  hasStarted: true,
  qualifierSlots: 2,
  qualifyingDrawSize: 4,
  qualifyingRoundCount: 2,
  wildCardSlots: 0,
  wildCardSlotsTaken: 0,
  qualifyingComplete: false,
  hasMainDraw: false,
  obligatory: false,
  entrants: [
    { playerId: 'qa', seed: null, entryType: 'Q', draw: 'qualifying' },
    { playerId: 'qb', seed: null, entryType: 'Q', draw: 'qualifying' },
    { playerId: 'qc', seed: null, entryType: 'Q', draw: 'qualifying' },
    { playerId: 'qd', seed: null, entryType: 'Q', draw: 'qualifying' },
  ],
  rounds: [],
  qualifyingRounds: [
    {
      roundNumber: 1,
      matches: [
        // Decided but NOT yet premiered — must be hidden.
        { entrantA: 'qa', entrantB: 'qb', outcome: outcome('qa', 'qb', [[6, 2], [6, 1]]), scheduledStartAt: future, revealSeconds: 900 },
        // Already premiered — must be shown.
        { entrantA: 'qc', entrantB: 'qd', outcome: outcome('qc', 'qd', [[6, 3], [6, 4]]), scheduledStartAt: past, revealSeconds: 900 },
      ],
    },
  ],
  doublesDrawSize: 4,
  doublesEntrants: [],
  doublesPairs: [
    { pairId: 'pairX', playerA: 'qa', playerB: 'qb', chemistry: 0 },
    { pairId: 'pairY', playerA: 'qc', playerB: 'qd', chemistry: 0 },
  ],
  doublesRounds: [
    {
      roundNumber: 1,
      matches: [
        // Doubles main draw, decided but not yet premiered — must be hidden.
        { entrantA: 'pairX', entrantB: 'pairY', outcome: outcome('pairX', 'pairY', [[7, 5], [6, 2]]), scheduledStartAt: future, revealSeconds: 900 },
      ],
    },
  ],
  doublesComplete: false,
  doublesQualifyingDrawSize: 0,
  doublesQualifierSlots: 0,
  doublesQualifyingPairs: [],
  doublesQualifyingRounds: [],
  doublesQualifyingComplete: false,
};

const NAMES: Record<string, string> = {
  qa: 'Alice Alpha',
  qb: 'Bob Beta',
  qc: 'Carol Gamma',
  qd: 'Dan Delta',
};

const player = (id: string) => ({
  id,
  name: NAMES[id] ?? id,
  nationality: 'PT',
  managerId: 'test-manager',
  ageInWeeks: 26 * 52,
  stage: 'prime',
  fatigue: 10,
  form: 10,
  fillOnly: false,
  attributes: {
    technical: { serve: 50, forehand: 50, backhand: 50, volley: 50 },
    physical: { speed: 50, stamina: 50, strength: 50 },
    mental: { consistency: 50, clutch: 50 },
    surfaceAffinities: { clay: 40, grass: 30, hard: 40, indoor: 30 },
  },
});

async function mockApi(page: Page): Promise<void> {
  await page.route('http://localhost:3000/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/tournaments/${tournamentId}`) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(tournament) });
      return;
    }
    const playerMatch = url.pathname.match(/^\/players\/([^/]+)$/);
    if (playerMatch) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(player(playerMatch[1])) });
      return;
    }
    if (url.pathname === '/world/clock') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          currentWeek: { season: 1, week: 3 },
          currentDay: 1,
          daysPerWeek: 7,
          nextTickAt: future,
          nextWeekTickAt: future,
          lastTickAt: past,
          stale: false,
        }),
      });
      return;
    }
    await route.continue();
  });
}

test.describe('one air predicate covers every bracket draw', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto(`/tournaments/${tournamentId}`);
  });

  test('a not-yet-premiered qualifying result is never shown, and the aired one is', async ({ page }) => {
    const panel = page.getByText('Qualifying', { exact: true }).locator('..').locator('..');
    await expect(panel).toBeVisible();

    // The decided-but-not-aired match renders as a matchup, not a result…
    await expect(page.getByText('Alice Alpha v Bob Beta')).toBeVisible();
    await expect(page.getByText('Alice Alpha def. Bob Beta')).toHaveCount(0);
    // …and its scoreline is nowhere on the page.
    await expect(page.getByText('6-2, 6-1')).toHaveCount(0);
    // The already-aired match is shown normally.
    await expect(page.getByText('Carol Gamma def. Dan Delta')).toBeVisible();
    await expect(page.getByText('6-3, 6-4')).toBeVisible();
  });

  test('a not-yet-premiered doubles result is hidden too', async ({ page }) => {
    await expect(page.getByText(/Alice Alpha \+ Bob Beta v Carol Gamma \+ Dan Delta/)).toBeVisible();
    await expect(page.getByText(/Alice Alpha \+ Bob Beta def\. Carol Gamma \+ Dan Delta/)).toHaveCount(0);
    await expect(page.getByText('7-5, 6-2')).toHaveCount(0);
  });

  test('the manual Simulate override is not rendered on the player-facing bracket', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Simulate' })).toHaveCount(0);
  });
});
