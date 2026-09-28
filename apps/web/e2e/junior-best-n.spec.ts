import { expect, Page, test } from '@playwright/test';

/**
 * Best-N legibility (junior best-6 cap, agent-season design item 1) —
 * browser regression test. The measured problem: a junior player
 * earned 2,174 U14 points and only 1,200 counted (45 results dropped,
 * 22 of them j100 titles), and NOTHING in the UI said only a player's
 * best 6 results count — "I won a j100 and my points didn't move" read
 * as a bug.
 *
 * This spec asserts the two surfaces a manager actually looks at:
 *   1. the player profile's junior band card states the best-6 rule, and
 *   2. each recent junior result is plainly marked as counting ("Counts
 *      toward the U16 ranking") or not ("Won't improve the U16 ranking —
 *      you already have 6 better results").
 *
 * The API is mocked; runs under the default (non-live) Playwright config.
 */

const baseAttributes = {
  technical: { serve: 60, forehand: 60, backhand: 60, volley: 60 },
  physical: { speed: 60, stamina: 60, strength: 60 },
  mental: { consistency: 70, clutch: 70 },
  doubles: 40,
  surfaceAffinities: { clay: 20, grass: 20, hard: 20, indoor: 20 },
};

/** Six big U16 results (700 down to 32) plus one fresh j100 title at 30 —
 * the exact shape that leaves the j100 win adding nothing. Newest first,
 * because the profile's history preview renders the first 3 rows. */
const history = [
  { tournamentId: 'h-j100', name: 'Fresh J100', tier: 'j100', ageBand: 'u16', surface: 'clay', weekScheduled: { season: 1, week: 12 }, drawSize: 32, hasStarted: true, cancelled: false, cancelReason: null, roundsWon: 5, won: true, eliminated: true, prizeMoney: 0, pointsEarned: 30 },
  { tournamentId: 'h-700', name: 'Big Final', tier: 'j200', ageBand: 'u16', surface: 'clay', weekScheduled: { season: 1, week: 10 }, drawSize: 32, hasStarted: true, cancelled: false, cancelReason: null, roundsWon: 5, won: true, eliminated: true, prizeMoney: 0, pointsEarned: 700 },
  { tournamentId: 'h-420', name: 'Runner-up', tier: 'j100', ageBand: 'u16', surface: 'hard', weekScheduled: { season: 1, week: 9 }, drawSize: 32, hasStarted: true, cancelled: false, cancelReason: null, roundsWon: 4, won: false, eliminated: true, prizeMoney: 0, pointsEarned: 420 },
  { tournamentId: 'h-252', name: 'Semifinal', tier: 'j100', ageBand: 'u16', surface: 'hard', weekScheduled: { season: 1, week: 8 }, drawSize: 32, hasStarted: true, cancelled: false, cancelReason: null, roundsWon: 3, won: false, eliminated: true, prizeMoney: 0, pointsEarned: 252 },
  { tournamentId: 'h-126', name: 'Quarterfinal', tier: 'j60', ageBand: 'u16', surface: 'grass', weekScheduled: { season: 1, week: 7 }, drawSize: 16, hasStarted: true, cancelled: false, cancelReason: null, roundsWon: 2, won: false, eliminated: true, prizeMoney: 0, pointsEarned: 126 },
  { tournamentId: 'h-63', name: 'Round of 16', tier: 'j60', ageBand: 'u16', surface: 'grass', weekScheduled: { season: 1, week: 6 }, drawSize: 16, hasStarted: true, cancelled: false, cancelReason: null, roundsWon: 1, won: false, eliminated: true, prizeMoney: 0, pointsEarned: 63 },
  { tournamentId: 'h-32', name: 'Round of 32', tier: 'j60', ageBand: 'u16', surface: 'grass', weekScheduled: { season: 1, week: 5 }, drawSize: 16, hasStarted: true, cancelled: false, cancelReason: null, roundsWon: 0, won: false, eliminated: true, prizeMoney: 0, pointsEarned: 32 },
];

function profileBody(): unknown {
  return {
    playerId: 'junior',
    name: 'Junior Test',
    nationality: 'PT',
    managerId: 'seed-m1',
    ageInWeeks: 15 * 52,
    stage: 'developing',
    currentEligibleBand: 'u16',
    careerPrizeMoney: 0,
    seasonPrizeMoney: 0,
    currentRankings: [
      { band: 'senior', totalPoints: 0, rank: null },
      { band: 'u14', totalPoints: 0, rank: null },
      { band: 'u16', totalPoints: 1593, rank: 4 },
      { band: 'u18', totalPoints: 0, rank: null },
    ],
    peakRankings: [{ band: 'u16', peakPoints: 1593, peakAsOfWeek: { season: 1, week: 12 } }],
    tournamentHistory: history,
    titles: [],
    titleSummary: { count: 0, weight: 0, byTier: {} },
    potential: {
      projectedOverallLow: 60,
      projectedOverallMid: 65,
      projectedOverallHigh: 70,
      developmentPercent: 55,
      tier: 'promising',
      confidence: 0.5,
      resolved: false,
      growth: 'steady',
      attributes: {
        technical: { serve: { current: 60, projected: 70, mature: false } },
        physical: { speed: { current: 60, projected: 70, mature: false } },
        mental: { consistency: { current: 70, projected: 70, mature: true } },
      },
    },
    doublesPartner: null,
    doublesPeaks: [],
    currentDoublesRankings: [
      { band: 'senior', totalPoints: 0, rank: null },
      { band: 'u14', totalPoints: 0, rank: null },
      { band: 'u16', totalPoints: 0, rank: null },
      { band: 'u18', totalPoints: 0, rank: null },
    ],
    doublesTitles: [],
    blockingCommitment: null,
  };
}

async function mockApi(page: Page): Promise<void> {
  await page.route('http://localhost:3000/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/players/junior') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'junior',
          name: 'Junior Test',
          nationality: 'PT',
          managerId: 'seed-m1',
          ageInWeeks: 15 * 52,
          stage: 'developing',
          fatigue: 0,
          form: 15,
          fillOnly: false,
          careerPrizeMoney: 0,
          seasonPrizeMoney: 0,
          attributes: baseAttributes,
        }),
      });
      return;
    }
    if (url.pathname === '/players/junior/profile') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(profileBody()) });
      return;
    }
    if (url.pathname === '/players/junior/current-matches') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ recent: [], next: null }) });
      return;
    }
    if (url.pathname === '/players/junior/entry-planner') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ week: { season: 1, week: 14 }, entries: [] }]) });
      return;
    }
    if (url.pathname === '/players/junior/training-schedule') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
      return;
    }
    if (/^\/managers\/[^/]+\/entitlement$/.test(url.pathname)) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ managerId: 'seed-m1', tier: 'free', customPlayerCredits: 0, xpBalance: 500 }),
      });
      return;
    }
    if (url.pathname === '/world/clock') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          currentWeek: { season: 1, week: 13 },
          currentDay: 2,
          daysPerWeek: 7,
          nextTickAt: new Date(Date.now() + 3_600_000).toISOString(),
          nextWeekTickAt: new Date(Date.now() + 3_600_000).toISOString(),
          lastTickAt: new Date().toISOString(),
          stale: false,
        }),
      });
      return;
    }
    await route.continue();
  });
}

test('the U16 band card states the best-6 rule, and a fresh j100 title is marked as not improving', async ({ page }) => {
  await mockApi(page);
  await page.goto('/players/junior');

  // (a) The rule itself, where the ranking is read.
  await expect(page.getByText(/only a player's best 6 results/i)).toBeVisible();
  // (b) The measured case: six better results exist, so the j100 title adds nothing.
  await expect(page.getByText(/Won't improve the U16 ranking — you already have 6 better results/)).toBeVisible();
});

test('a result that breaks into the best 6 is marked as counting, not as displaced', async ({ page }) => {
  await mockApi(page);
  await page.goto('/players/junior');

  // The 700-point title is inside the best 6 — it counts.
  await expect(page.getByText(/Counts toward the U16 ranking/).first()).toBeVisible();
});
