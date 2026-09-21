import { randomUUID } from 'node:crypto';

/**
 * Shared constants for the LIVE end-to-end suite (see
 * playwright.live.config.ts and *.live.spec.ts).
 *
 * These specs drive the REAL web app against the REAL API — no
 * `page.route` mocking (unlike the long-standing replay.spec.ts). That
 * needs a dedicated, run-unique dev manager so repeated runs never
 * collide on roster state.
 *
 * The manager id MUST be identical in three places: the test worker
 * (to call manager-scoped API routes directly), the dev server's
 * `NEXT_PUBLIC_DEV_MANAGER_ID` (inlined into the browser bundle at
 * server start — that's why it cannot be typed per page), and therefore
 * the config. playwright.live.config.ts generates it once, writes it
 * back to `process.env.E2E_MANAGER_ID` (inherited by the forked worker
 * processes) and passes it to the web server's env. When the env var is
 * already set (e.g. an operator pinning it), that value wins.
 */
export const LIVE_MANAGER_ID =
  process.env.E2E_MANAGER_ID ?? `e2e-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

/** The API origin the browser and the direct test-client calls use.
 * 127.0.0.1 on purpose: the API binds IPv4, and `localhost` can resolve
 * to ::1 first on Windows, where nothing is listening. */
export const LIVE_API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';

/** The fixed-id demo draw the alpha bootstrap opens, fills and seeds so
 * a tester can watch a match the same day (see
 * apps/api/src/scripts/bootstrapTestWorld.ts). */
export const DEMO_TOURNAMENT_ID = 'bootstrap-demo-futures';
