import { expect, test } from './live.fixtures';
import { DEMO_TOURNAMENT_ID, LIVE_MANAGER_ID } from './liveSupport';

/**
 * The first-session LIVE suite — the only tests that drive the real
 * browser UI against the real API (no `page.route` mocks anywhere).
 *
 * Run with: `npm run test:e2e:live -w apps/web`
 * Requires (see playwright.live.config.ts):
 *   - the API on http://127.0.0.1:3000 with AUTH_MODE=development,
 *   - a bootstrapped world (npm run bootstrap -w apps/api),
 *   - the worker STOPPED (so the world can't mutate mid-test).
 *
 * Serial + single worker: every page shares the ONE run-unique dev
 * manager id injected at dev-server start, so the roster is built up
 * step by step in declaration order (onboarding -> claim -> enter).
 * Determinism rule throughout: poll the API for a condition rather than
 * `waitForTimeout`, and assert on values captured from the API at
 * runtime (never hardcoded generated names/scores).
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ api }) => {
  // Create the manager account ONCE, deterministically, before any page
  // renders. The roster page fires several manager-scoped reads in
  // parallel on first load; doing this first means the starter-XP grant
  // happens exactly once, so spec (i) can assert the real 500-XP copy
  // instead of racing the documented concurrent-first-request grant.
  const response = await api.get(`/managers/${encodeURIComponent(LIVE_MANAGER_ID)}/entitlement`);
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).xpBalance).toBe(500);
});

test('(i) landing: a brand-new manager sees the empty-roster onboarding', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Welcome to the circuit')).toBeVisible();
  await expect(page.getByText('Sign a prospect')).toBeVisible();
  await expect(page.getByText('Enter a tournament')).toBeVisible();
  await expect(page.getByText('Climb the rankings')).toBeVisible();

  await expect(page.getByText('0 / 2 slots')).toBeVisible();
  await expect(page.getByText(/You have 500 XP/)).toBeVisible();
  await expect(page.getByText(/enough to sign your first player/i)).toBeVisible();
});

test('(ii) scouting: claim a free agent and watch the roster update', async ({ page }) => {
  await page.goto('/scouting');

  const poolLabel = page.getByText(/\d+ free agents? available/);
  await expect(poolLabel).toBeVisible();
  const before = Number(((await poolLabel.innerText()).match(/(\d+)/) ?? ['', '0'])[1]);
  expect(before).toBeGreaterThan(0);

  // The first AFFORDABLE candidate (Sign is disabled for one the manager
  // can't afford yet — the pool is never hidden, just disabled).
  const sign = page.getByRole('button', { name: 'Sign', exact: true }).and(page.locator('button:enabled')).first();
  await expect(sign).toBeVisible();
  await sign.click();

  await expect(page.getByText(/Signed .* welcome to the academy/)).toBeVisible();

  // The pool is refetched after a successful claim; poll until the count
  // reflects the signing rather than sleeping a fixed time.
  await expect
    .poll(
      async () => {
        const text = await poolLabel.innerText().catch(() => '');
        const match = text.match(/(\d+)/);
        return match ? Number(match[1]) : -1;
      },
      { timeout: 30_000 },
    )
    .toBe(before - 1);

  await page.goto('/');
  await expect(page.getByText('1 player')).toBeVisible();
  await expect(page.getByText('1 / 2 slots')).toBeVisible();
});

test('(iii) enter a tournament: modal shows rewards and the entry is recorded', async ({ page, api }) => {
  await page.goto('/');

  // Capture the claimed player's real id/name at runtime; nothing here
  // is hardcoded.
  const rosterResponse = await api.get(`/managers/${encodeURIComponent(LIVE_MANAGER_ID)}/roster-dashboard`);
  expect(rosterResponse.ok()).toBeTruthy();
  const roster = (await rosterResponse.json()) as Array<{ id: string; name: string }>;
  expect(roster.length).toBe(1);
  const { id: playerId } = roster[0];

  await page.getByRole('button', { name: 'Enter', exact: true }).first().click();

  const modal = page.locator('div.fixed.inset-0.z-50');
  await expect(modal).toBeVisible();
  await expect(modal.getByText(`Enter ${roster[0].name} into a tournament`)).toBeVisible();

  // Every candidate row carries the reward summary (points + prize),
  // straight from the DTO's real breakdown arrays.
  await expect(modal.getByText(/★ Champion/).first()).toBeVisible();

  // Pick the first eligible (non-blocked) tournament.
  const candidate = modal.locator('button:enabled').filter({ hasText: /season \d+, week \d+/ }).first();
  await expect(candidate).toBeVisible();
  await candidate.click();

  // Selecting one reveals the full ladder and the real first-round rule.
  await expect(modal.getByText(/A first-round loss earns no ranking points/)).toBeVisible();

  const [enterResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        /\/tournaments\/[^/]+\/entrants$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'POST',
    ),
    modal.getByRole('button', { name: 'Enter tournament' }).click(),
  ]);
  const enteredTournament = (await enterResponse.json()) as { id: string };

  await expect(page.getByText(/^Entered /)).toBeVisible();

  // Verify against the API, not just the optimistic notice.
  const detailResponse = await api.get(`/tournaments/${enteredTournament.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()) as { entrants: Array<{ playerId: string }> };
  expect(detail.entrants.map((e) => e.playerId)).toContain(playerId);
});

test('(iv) decided tournament + replay: real scoreline, playback, completion', async ({ page, api }) => {
  const response = await api.get(`/tournaments/${DEMO_TOURNAMENT_ID}`);
  expect(response.ok()).toBeTruthy();
  const tournament = (await response.json()) as {
    hasStarted: boolean;
    rounds: Array<{
      roundNumber: number;
      matches: Array<{
        outcome: { setScores: Array<{ winnerGames: number; loserGames: number }> } | null;
        scheduledStartAt: string | null;
        revealSeconds: number;
      }>;
    }>;
  };
  expect(tournament.hasStarted).toBe(true);

  // Earliest decided match — its reveal window is the first to elapse.
  let pick: { roundNumber: number; matchIndex: number; match: (typeof tournament.rounds)[number]['matches'][number] } | null = null;
  for (const round of tournament.rounds) {
    for (let i = 0; i < round.matches.length; i++) {
      const match = round.matches[i];
      if (!match.outcome) continue;
      if (!pick || new Date(match.scheduledStartAt ?? 0).getTime() < new Date(pick.match.scheduledStartAt ?? 0).getTime()) {
        pick = { roundNumber: round.roundNumber, matchIndex: i, match };
      }
    }
  }
  expect(pick).not.toBeNull();
  const { match } = pick!;
  const expectedScore = match.outcome!.setScores.map((s) => `${s.winnerGames}-${s.loserGames}`).join(', ');
  const matchId = `${DEMO_TOURNAMENT_ID}-r${pick!.roundNumber}-m${pick!.matchIndex}`;

  // The staggered "Premiere" schedule anchors each replay to its own
  // scheduled start, so a match simulated in the last ~15 minutes is not
  // fully aired yet and the bracket hides its result behind a countdown.
  // Handle that explicitly (not by flaking): move the BROWSER clock past
  // the reveal window so both the bracket result and playback are
  // unlocked deterministically, with no real-time wait.
  const airedAt = match.scheduledStartAt ? new Date(match.scheduledStartAt).getTime() + (match.revealSeconds ?? 0) * 1000 : 0;
  const neededMs = airedAt - Date.now();
  const fastForwarded = neededMs > 0;
  if (fastForwarded) await page.clock.install();

  await page.goto(`/tournaments/${DEMO_TOURNAMENT_ID}`);
  if (fastForwarded) await page.clock.fastForward(neededMs + 60_000);

  // A real, decided scoreline from the bootstrapped demo draw.
  await expect(page.getByText(expectedScore).first()).toBeVisible();
  await expect(page.getByText(/def\./).first()).toBeVisible();

  await page.goto(`/replay/${matchId}`);

  // The Premiere overlay is always the entry state; pressing play is what
  // starts the fake-live playback.
  await expect(page.getByText(/Premieres at/)).toBeVisible();
  await page.getByRole('button', { name: 'Watch replay' }).click();
  await page.getByRole('button', { name: 'Very fast (~5s)' }).click();

  // Drive playback: either it already runs on the real timer (fully
  // aired) or the faked clock needs an explicit advance to fire the
  // playback interval.
  if (fastForwarded) await page.clock.fastForward(60_000);

  const completionBanner = page.getByTestId('completion-banner');
  await expect(completionBanner).toBeVisible({ timeout: 60_000 });
  // Scoped to the banner: the page's breadcrumb also reads "← Back to
  // bracket", so an unscoped role query is ambiguous.
  await expect(completionBanner.getByRole('link', { name: 'Back to bracket' })).toBeVisible();
});

test('(v) world clock chrome renders season/week, day and the next-day countdown', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText(/Season \d+ · Week \d+/)).toBeVisible();
  await expect(page.getByText(/\d+ \/ 7/)).toBeVisible();
  await expect(page.getByText('Next day', { exact: true })).toBeVisible();

  // Assert the FORMAT of the live countdown, never a specific value.
  // formatCountdown emits coarse buckets ("4h 12m" / "5m 03s" / "2d 4h 12m").
  await expect(page.getByText(/^\d+(d \d+h \d+m|h \d+m|m \d{2}s)$/).first()).toBeVisible();
});
