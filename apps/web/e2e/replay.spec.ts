import { expect, Page, test } from '@playwright/test';

const tournamentId = 'test-open';
const matchId = `${tournamentId}-r1-m0`;

const replayLog = {
  entries: [
    { offsetSeconds: 20, setNumber: 1, gamesForA: 1, gamesForB: 0, wonBy: 'A', server: 'A' },
    { offsetSeconds: 30, setNumber: 1, gamesForA: 2, gamesForB: 0, wonBy: 'A', server: 'B' },
    { offsetSeconds: 40, setNumber: 1, gamesForA: 3, gamesForB: 0, wonBy: 'A', server: 'A' },
    { offsetSeconds: 50, setNumber: 1, gamesForA: 4, gamesForB: 0, wonBy: 'A', server: 'B' },
    { offsetSeconds: 60, setNumber: 1, gamesForA: 5, gamesForB: 0, wonBy: 'A', server: 'A' },
    { offsetSeconds: 70, setNumber: 1, gamesForA: 5, gamesForB: 1, wonBy: 'B', server: 'B' },
    { offsetSeconds: 80, setNumber: 1, gamesForA: 5, gamesForB: 2, wonBy: 'B', server: 'A' },
    { offsetSeconds: 90, setNumber: 1, gamesForA: 5, gamesForB: 3, wonBy: 'B', server: 'B' },
    { offsetSeconds: 100, setNumber: 1, gamesForA: 5, gamesForB: 4, wonBy: 'B', server: 'A' },
    { offsetSeconds: 110, setNumber: 1, gamesForA: 5, gamesForB: 5, wonBy: 'B', server: 'B' },
    { offsetSeconds: 120, setNumber: 1, gamesForA: 6, gamesForB: 5, wonBy: 'A', server: 'A' },
    { offsetSeconds: 130, setNumber: 1, gamesForA: 6, gamesForB: 6, wonBy: 'B', server: 'B' },
    { offsetSeconds: 145, setNumber: 1, gamesForA: 7, gamesForB: 6, wonBy: 'A', server: 'A' },
    { offsetSeconds: 520, setNumber: 2, gamesForA: 1, gamesForB: 0, wonBy: 'A', server: 'B' },
    { offsetSeconds: 530, setNumber: 2, gamesForA: 2, gamesForB: 0, wonBy: 'A', server: 'A' },
    { offsetSeconds: 540, setNumber: 2, gamesForA: 3, gamesForB: 0, wonBy: 'A', server: 'B' },
    { offsetSeconds: 550, setNumber: 2, gamesForA: 4, gamesForB: 0, wonBy: 'A', server: 'A' },
    { offsetSeconds: 560, setNumber: 2, gamesForA: 5, gamesForB: 0, wonBy: 'A', server: 'B' },
    { offsetSeconds: 570, setNumber: 2, gamesForA: 6, gamesForB: 0, wonBy: 'A', server: 'A' },
  ],
  points: [
    { offsetSeconds: 100, setNumber: 1, gameNumber: 1, pointScoreA: '40', pointScoreB: '40', wonBy: 'A' },
    { offsetSeconds: 125, setNumber: 1, gameNumber: 12, pointScoreA: '40', pointScoreB: '0', wonBy: 'B' },
    { offsetSeconds: 300, setNumber: 1, gameNumber: 1, pointScoreA: 'Ad', pointScoreB: '40', wonBy: 'B' },
    { offsetSeconds: 500, setNumber: 1, gameNumber: 13, pointScoreA: '6', pointScoreB: '5', wonBy: 'A' },
  ],
  totalDurationSeconds: 600,
  simulatedAt: '2020-01-01T12:00:00.000Z',
};

const tournament = {
  id: tournamentId,
  tier: 'challenger',
  surface: 'clay',
  weekScheduled: { season: 1, week: 1 },
  drawSize: 16,
  hasStarted: true,
  entrants: [
    { playerId: 'test-a', seed: 1 },
    { playerId: 'test-b', seed: 2 },
    { playerId: 'test-c', seed: 3 },
  ],
  rounds: [
    {
      roundNumber: 1,
      matches: [
        {
          entrantA: 'test-a',
          entrantB: 'test-b',
          outcome: {
            winner: 'test-a',
            loser: 'test-b',
            setScores: [
              { winnerGames: 7, loserGames: 6 },
              { winnerGames: 6, loserGames: 0 },
            ],
          },
        },
      ],
    },
    {
      roundNumber: 2,
      matches: [{ entrantA: 'test-a', entrantB: 'test-c', outcome: null }],
    },
  ],
};

const player = (id: string, name: string) => ({
  id,
  name,
  nationality: 'PT',
  managerId: 'test-manager',
  ageInWeeks: 26 * 52,
  stage: 'prime',
  fatigue: 10,
  currentFocus: null,
  attributes: {
    technical: { serve: 50, forehand: 50, backhand: 50, volley: 50 },
    physical: { speed: 50, stamina: 50, strength: 50 },
    mental: { consistency: 50, clutch: 50 },
    surfaceAffinities: { clay: 40, grass: 30, hard: 40, indoor: 30 },
  },
});

async function mockReplayApi(page: Page, log = replayLog): Promise<void> {
  await page.route('http://localhost:3000/**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === `/match-logs/${matchId}.json`) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(log) });
      return;
    }
    if (url.pathname === `/tournaments/${tournamentId}`) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(tournament) });
      return;
    }
    if (url.pathname === '/players/test-a') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(player('test-a', 'Player Alpha')) });
      return;
    }
    if (url.pathname === '/players/test-b') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(player('test-b', 'Player Beta')) });
      return;
    }
    if (url.pathname === '/players/test-c') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(player('test-c', 'Player Gamma')) });
      return;
    }

    await route.continue();
  });
}

test.describe('match replay', () => {
  test.beforeEach(async ({ page }) => {
    await mockReplayApi(page);
  });

  test('shows the Premiere pre-play state and the three set columns', async ({ page }) => {
    await page.goto(`/replay/${matchId}`);
    await expect(page.getByText('Premieres at 12:00 PM')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Watch replay' })).toBeVisible();
    await expect(page.getByText('SET 1')).toBeVisible();
    await expect(page.getByText('SET 2')).toBeVisible();
    await expect(page.getByText('SET 3')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/\blive\b/i);
  });

  test('renders point states, commentary, scrub marks, and completion navigation', async ({ page }) => {
    await page.goto(`/replay/${matchId}`);
    await page.getByRole('button', { name: 'Watch replay' }).click();

    await expect(page.getByTestId('current-point')).toContainText('Deuce');
    await expect(page.getByText('Nothing notable yet — keep watching')).toBeVisible();
    const deuceBackground = await page.getByTestId('current-point').evaluate((element) => getComputedStyle(element).backgroundColor);

    await page.waitForTimeout(1_700);
    await expect(page.getByTestId('current-point')).toContainText('Advantage');
    const advantageBackground = await page.getByTestId('current-point').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(advantageBackground).not.toBe(deuceBackground);

    await expect(page.getByTestId('scrub-bar').getByTestId('scrub-tick').first()).toBeVisible();

    await page.getByRole('button', { name: 'Very fast (~5s)' }).click();
    await expect(page.getByTestId('completion-banner')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId('commentary-feed')).toContainText('BREAK');
    await expect(page.getByTestId('commentary-feed')).toContainText('tiebreak');
    const commentary = await page.getByTestId('commentary-feed').innerText();
    expect(commentary.indexOf('wins the match')).toBeLessThan(commentary.indexOf('heads to a tiebreak'));
    await expect(page.getByTestId('completion-banner').getByRole('link', { name: 'Back to bracket' })).toHaveAttribute('href', `/tournaments/${tournamentId}`);
    await expect(page.getByTestId('completion-banner').getByRole('link', { name: 'View Quarterfinal →' })).toHaveAttribute('href', `/tournaments/${tournamentId}#round-2`);
    await expect(page.locator('body')).not.toContainText(/\blive\b/i);
  });

  test('stops at the Premiere edge and caps seeking', async ({ page }) => {
    await page.unroute('http://localhost:3000/**');
    await mockReplayApi(page, { ...replayLog, simulatedAt: new Date(Date.now() - 5_000).toISOString() });
    await page.goto(`/replay/${matchId}`);
    await page.getByRole('button', { name: 'Watch replay' }).click();

    await expect(page.getByTestId('replay-status')).toContainText('caught up');
    await expect(page.getByRole('button', { name: 'Very fast (~5s)' })).toBeDisabled();
    const scrub = page.getByTestId('scrub-bar').locator('input[type="range"]');
    await scrub.fill('600');
    expect(Number(await scrub.inputValue())).toBeLessThan(100);
    await expect(page.locator('body')).not.toContainText(/\blive\b/i);
  });
});
