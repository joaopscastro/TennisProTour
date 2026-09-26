import { expect, Page, test } from '@playwright/test';

/**
 * Browser regression test for a third-round walkthrough finding: losing the
 * atomic free-agent claim race returned a 409, but the Scouting page swallowed
 * it — no message, no roster change, card gone — so agents concluded signing
 * was broken. A lost race now says so plainly AND refreshes the pool.
 *
 * The API is mocked; runs under the default (non-live) Playwright config.
 */

const candidate = {
  id: 'fa-1',
  name: 'Rita Racer',
  nationality: 'PT',
  ageInWeeks: 16 * 52,
  claimCost: 50,
  careerPrizeMoney: 0,
  titleCount: 0,
  titleWeight: 0,
  titlesByTier: {},
  currentTournament: null,
  attributes: {
    technical: { serve: 40, forehand: 40, backhand: 40, volley: 40 },
    physical: { speed: 40, stamina: 40, strength: 40 },
    mental: { consistency: 40, clutch: 40 },
    surfaceAffinities: { clay: 30, grass: 30, hard: 30, indoor: 30 },
  },
};

async function mockApi(page: Page): Promise<void> {
  let raceLost = false;
  await page.route('http://localhost:3000/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/talent-pool') {
      // Before the race: one available agent. After the 409: empty, so the
      // stale card is gone with the explanation. (A flag rather than a fetch
      // counter — React StrictMode double-invokes effects in dev.)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(raceLost ? [] : [candidate]) });
      return;
    }
    if (/^\/talent-pool\/[^/]+\/claim$/.test(url.pathname)) {
      raceLost = true;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Free agent is no longer available to sign' }) });
      return;
    }
    if (/^\/managers\/[^/]+\/entitlement$/.test(url.pathname)) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ managerId: 'm', tier: 'free', customPlayerCredits: 0, xpBalance: 500 }) });
      return;
    }
    if (url.pathname === '/world/clock') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          currentWeek: { season: 1, week: 1 },
          currentDay: 1,
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

test('a lost claim race is explained, not swallowed', async ({ page }) => {
  await mockApi(page);
  await page.goto('/scouting');

  await expect(page.getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();

  // Honest, specific outcome — not silence.
  await expect(page.getByText(/Another manager signed Rita Racer first/)).toBeVisible();
  // And the stale card is gone (the pool refreshed).
  await expect(page.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0);
});
