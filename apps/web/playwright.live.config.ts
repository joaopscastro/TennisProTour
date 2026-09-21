import { defineConfig, devices } from '@playwright/test';
import { LIVE_API_URL, LIVE_MANAGER_ID } from './e2e/liveSupport';

/**
 * Playwright config for the LIVE end-to-end suite (`.live.spec.ts`).
 *
 * Deliberately separate from the default `playwright.config.ts` (which
 * runs the fully-mocked `replay.spec.ts`). These specs need a running
 * API + a bootstrapped world and NEVER call `page.route` — they are the
 * only tests that drive the real UI against the real backend.
 *
 * Key choices:
 *  - `fullyParallel: false`, `workers: 1`, `retries: 0`: the specs share
 *    ONE dev manager id (injected below) and build on each other's state
 *    (onboarding -> claim -> enter). Serial execution keeps that a
 *    fixture, not a race; retries would re-run against mutated state.
 *  - `NEXT_PUBLIC_DEV_MANAGER_ID` is passed through `webServer.env`; it
 *    is inlined into the client bundle when the dev server starts, which
 *    is the only way to give every page the same manager id (the id is
 *    NOT persisted across pages by the app itself).
 *  - `NEXT_PUBLIC_API_URL` points at 127.0.0.1 (not `localhost`) so the
 *    browser can't resolve to an IPv6 address the API isn't bound to.
 *  - No `testMatch` overlap with the default config: the default config
 *    ignores `**\/*.live.spec.ts` (see playwright.config.ts).
 */
process.env.E2E_MANAGER_ID = LIVE_MANAGER_ID;
process.env.E2E_API_URL = LIVE_API_URL;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Default artifact dirs (`test-results/`, `playwright-report/`) are
  // already gitignored; traces/screenshots are retained only on failure.
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_API_URL: LIVE_API_URL,
      NEXT_PUBLIC_DEV_MANAGER_ID: LIVE_MANAGER_ID,
      // Explicitly empty: no Clerk provider, so AuthGate renders the
      // children and the dev manager-id input path is used.
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
    },
  },
});
