import { expect, Page, test } from '@playwright/test';

/**
 * Batch 3.2 browser regression test: a profile whose CURRENT week's
 * training focus is a physical attribute with no projected headroom
 * shows the plain-language "dead focus" note; a focus with real
 * projected headroom shows nothing.
 *
 * The live case this fixes: a speed attribute sat at its hidden ceiling
 * (~82) while the profile's ghost-cap bar promised headroom that could
 * not exist, and the manager spent weeks of XP training it for nothing.
 * The projection now never exceeds the true ceiling (one-sided physical
 * fuzz) and this note says so out loud.
 *
 * The API is mocked; runs under the default (non-live) Playwright config.
 */

const WEEKS = [{ week: { season: 1, week: 3 }, entries: [] }];

const baseAttributes = {
  technical: { serve: 60, forehand: 60, backhand: 60, volley: 60 },
  physical: { speed: 82, stamina: 60, strength: 60 },
  mental: { consistency: 70, clutch: 70 },
  doubles: 40,
  surfaceAffinities: { clay: 20, grass: 20, hard: 20, indoor: 20 },
};

function projection(attr: { current: number; projected: number }, mature = false): { current: number; projected: number; mature: boolean } {
  return { ...attr, mature };
}

function profileBody(speedProjected: number): unknown {
  return {
    playerId: 'amara',
    name: 'Amara Test',
    nationality: 'PT',
    managerId: 'seed-m1',
    ageInWeeks: 20 * 52,
    stage: 'prime',
    currentEligibleBand: 'senior',
    careerPrizeMoney: 0,
    seasonPrizeMoney: 0,
    currentRankings: [
      { band: 'senior', totalPoints: 0, rank: null },
      { band: 'u14', totalPoints: 0, rank: null },
      { band: 'u16', totalPoints: 0, rank: null },
      { band: 'u18', totalPoints: 0, rank: null },
    ],
    peakRankings: [],
    tournamentHistory: [],
    titles: [],
    titleSummary: { count: 0, weight: 0, byTier: {} },
    // resolved:false deliberately — keeps the P5 resolution celebration
    // out of this test; it is unrelated to the focus warning.
    potential: {
      projectedOverallLow: 82,
      projectedOverallMid: 82,
      projectedOverallHigh: 82,
      developmentPercent: 55,
      tier: 'promising',
      confidence: 0.5,
      resolved: false,
      growth: 'steady',
      attributes: {
        technical: {
          serve: projection({ current: 60, projected: 70 }),
          forehand: projection({ current: 60, projected: 70 }),
          backhand: projection({ current: 60, projected: 70 }),
          volley: projection({ current: 60, projected: 70 }),
        },
        physical: {
          // The attribute under test: maxed (current 82) in the dead case.
          speed: projection({ current: 82, projected: speedProjected }),
          stamina: projection({ current: 60, projected: 75 }),
          strength: projection({ current: 60, projected: 75 }),
        },
        mental: {
          consistency: projection({ current: 70, projected: 70 }, true),
          clutch: projection({ current: 70, projected: 70 }, true),
        },
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

async function mockApi(page: Page, speedProjected: number): Promise<void> {
  await page.route('http://localhost:3000/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/players/amara') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'amara',
          name: 'Amara Test',
          nationality: 'PT',
          managerId: 'seed-m1',
          ageInWeeks: 20 * 52,
          stage: 'prime',
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
    if (url.pathname === '/players/amara/profile') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(profileBody(speedProjected)) });
      return;
    }
    if (url.pathname === '/players/amara/current-matches') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ recent: [], next: null }) });
      return;
    }
    if (url.pathname === '/players/amara/entry-planner') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(WEEKS) });
      return;
    }
    if (url.pathname === '/players/amara/training-schedule') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ week: { season: 1, week: 3 }, focus: { kind: 'attribute', attribute: 'speed' }, isExplicit: true }]),
      });
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
          currentWeek: { season: 1, week: 3 },
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

test('a maxed physical focus shows the dead-focus note', async ({ page }) => {
  await mockApi(page, 82); // projected === current: no headroom, no ghost bar
  await page.goto('/players/amara');

  await expect(page.getByText(/no remaining physical headroom here/)).toBeVisible();
});

test('a physical focus with real projected headroom shows no note', async ({ page }) => {
  await mockApi(page, 90); // real headroom — the note must stay away
  await page.goto('/players/amara');

  // Wait for the Schedule section to actually render (so "note absent"
  // is a real assertion, not a raced loading state).
  await expect(page.getByText('Planner window')).toBeVisible();
  await expect(page.getByText(/no remaining physical headroom/)).toHaveCount(0);
});
