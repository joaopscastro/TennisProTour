// Explicit path, not the bare 'dotenv/config' import: that reads .env
// relative to process.cwd(), which happens to be apps/api only when
// launched via `npm run start -w apps/api` — any other launch method
// (e.g. `node dist/index.js` from the repo root, as
// scripts/boot-smoke-test.sh does) would silently see none of .env's
// values. Resolving against __dirname instead makes this independent
// of whatever directory the process was actually started from, and
// points every app at the SAME single repo-root .env (see
// .env.example) rather than each needing its own copy.
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(__dirname, '../../../.env') });

import { createDb } from './db/client';
import { buildDependencies, resolveAuthMode, resolveNotificationEmailMode } from './composition';
import { resolveMatchLogDirectory } from './matchLogDirectory';
import { buildApp } from './app';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const port = Number(process.env.PORT ?? 3000);
const matchLogDirectory = resolveMatchLogDirectory();

async function main(): Promise<void> {
  // Clerk config is validated HERE, not in buildDependencies: that
  // function is shared by apps/worker and every seed script, none of
  // which serve HTTP and must not be required to carry Clerk secrets.
  // This is the one entry point that actually authenticates requests.
  // resolveAuthMode() is the same fail-closed resolution the composition
  // root uses, so the two can't drift.
  if (resolveAuthMode() === 'clerk') {
    if (!process.env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is required when AUTH_MODE=clerk');
    if (process.env.NODE_ENV === 'production' && !process.env.CLERK_AUTHORIZED_PARTIES) {
      throw new Error('CLERK_AUTHORIZED_PARTIES is required in production');
    }
  }
  // Notifications fail OFF (unset = no digest scheduler registered), so
  // only a deliberate `resend` deploy can be misconfigured here — and a
  // missing key then throws at boot rather than surfacing later as a
  // stream of silently-`failed` deliveries. Same boot-check style as
  // CLERK_SECRET_KEY above; resolved through the composition's own
  // resolver so the two can't disagree.
  if (resolveNotificationEmailMode() === 'resend' && !process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is required when NOTIFICATION_EMAIL_MODE=resend');
  }
  // INTERNAL_ADMIN_TOKEN is optional in dev, but silently disabling the
  // only server-to-server admin gate in production should at least be
  // visible in the boot log rather than a mystery 403 later.
  if (process.env.NODE_ENV === 'production' && !process.env.INTERNAL_ADMIN_TOKEN) {
    // eslint-disable-next-line no-console
    console.warn('[startup] INTERNAL_ADMIN_TOKEN is unset in production — server-to-server admin routes will refuse all requests');
  }

  const db = createDb(connectionString);

  // Deferred so the app (and its logger) exists before deps that log.
  let app: ReturnType<typeof buildApp>;
  const deps = buildDependencies({
    db,
    matchLogDirectory,
    // Default to this API's own dev blob route so simulate responses
    // return browser-fetchable replay URLs out of the box.
    matchLogPublicBaseUrl: process.env.MATCH_LOG_PUBLIC_BASE_URL ?? `http://localhost:${port}/match-logs`,
    logEvent: (message, payload) => app.log.info(payload, message),
  });
  app = buildApp({ deps, matchLogDirectory });

  // Boot log of the ABSOLUTE resolved path, so a cross-process mismatch
  // (the old cwd-relative bug) is visible at a glance instead of only as
  // a 404 when a replay is opened. See matchLogDirectory.ts.
  app.log.info({ matchLogDirectory }, 'match-log store directory resolved');

  // One explicit line stating the resolved world-tick cadence. The API
  // doesn't schedule the tick, but it recomputes /world/clock's countdown
  // from this same value — so logging it here makes the api↔worker
  // coupling auditable at a glance. Interval mode (WORLD_TICK_INTERVAL_MS
  // set) is the production mechanism for the compressed clock, not a
  // dev-only path.
  const worldTickIntervalMsRaw = process.env.WORLD_TICK_INTERVAL_MS;
  const worldTickIntervalMs = worldTickIntervalMsRaw ? Number(worldTickIntervalMsRaw) : null;
  const worldTickCron = process.env.WORLD_TICK_CRON ?? '0 3 * * *';
  app.log.info(
    worldTickIntervalMs !== null && Number.isFinite(worldTickIntervalMs) && worldTickIntervalMs > 0
      ? { worldTick: { mode: 'interval', everyMsPerDay: worldTickIntervalMs } }
      : { worldTick: { mode: 'cron', pattern: worldTickCron } },
    'world tick cadence resolved',
  );

  // One explicit line stating the resolved notification email mode, so a
  // silent `off` (the fail-safe default) is visible rather than a mystery
  // "why did nobody get a digest" later. See resolveNotificationEmailMode.
  app.log.info({ notificationEmailMode: deps.notificationEmailMode }, 'notification email mode resolved');

  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
