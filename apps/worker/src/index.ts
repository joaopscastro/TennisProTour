// Same explicit, cwd-independent .env loading as apps/api/src/index.ts
// — one shared repo-root .env configures both processes identically
// (WORLD_TICK_INTERVAL_MS in particular needs to reach apps/worker,
// the process that actually schedules the tick).
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(__dirname, '../../../.env') });

import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { GameWorld, WorldId } from '@tennis-manager/domain';
import { buildDependencies, createDb, resolveMatchLogDirectory } from '@tennis-manager/api';
import { AdvanceWorldJobData, makeAdvanceWorldHandler } from './jobs/handlers';
import { makeSendManagerDigestsHandler } from './jobs/notificationJobs';
import { removeLegacySchedulers } from './jobs/reconcileSchedulers';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
// Shared, repo-root-anchored resolution (see matchLogDirectory.ts) — the
// worker and the API must agree on ONE directory or auto-simulated
// replays 404 when served by the API.
const matchLogDirectory = resolveMatchLogDirectory();
const worldId = process.env.WORLD_ID ?? 'main';
// World tick is now one game DAY per firing (see
// docs/day-tick-and-scheduling.md). Default: daily 03:00 UTC. Match
// simulation and weekly work are both folded into this single tick — a
// week is 7 day-ticks, and the heavy weekly systems fire on the 7->1
// rollover only. There is no separate match-sweep job anymore.
const worldTickCron = process.env.WORLD_TICK_CRON ?? '0 3 * * *';

/**
 * The production mechanism for a COMPRESSED world clock: fire the world
 * tick every N milliseconds instead of the daily cron above. One tick =
 * one game DAY, so this is MS-PER-DAY; the ship cadence is
 * WORLD_TICK_INTERVAL_MS=7200000 (2 real hours per game day, ~30 real
 * days per season). Unset keeps worldTickCron in full control.
 *
 * It MUST be set identically on both apps/worker (which schedules the
 * tick) and apps/api (whose /world/clock countdown recomputes it) — a
 * mismatch makes the UI project the daily cron instead, and the stale
 * threshold silently becomes 48h. A sub-daily CRON cannot substitute for
 * this: the day tick's idempotency key hashes to the UTC date, so a
 * second same-day firing is refused as a duplicate (see tickKey.ts).
 */
const worldTickIntervalMsRaw = process.env.WORLD_TICK_INTERVAL_MS;
const worldTickIntervalMs = worldTickIntervalMsRaw ? Number(worldTickIntervalMsRaw) : null;
if (worldTickIntervalMsRaw !== undefined && (!Number.isFinite(worldTickIntervalMs) || (worldTickIntervalMs as number) <= 0)) {
  throw new Error(`WORLD_TICK_INTERVAL_MS must be a positive number of milliseconds, got "${worldTickIntervalMsRaw}"`);
}

const WORLD_QUEUE = 'world';
/** Legacy queue + scheduler ids from before the day tick existed: the
 * per-5-minute match sweep lived on its own `matches` queue, and the
 * world tick was `advance-world-week`. Both are removed on boot so an
 * upgrade cleans up after itself (see reconcileSchedulers.ts). */
const LEGACY_MATCHES_QUEUE = 'matches';
const LEGACY_WORLD_SCHEDULERS = ['advance-world-week'] as const;
const LEGACY_MATCHES_SCHEDULERS = ['simulate-due-matches'] as const;
const NOTIFICATIONS_QUEUE = 'notifications';
// One digest run per day by default; overridable for fast local/test
// cycles. Only matters when a real digest mode is configured — in the
// fail-safe 'off' default the scheduler is not registered at all.
const DEFAULT_NOTIFICATION_DIGEST_INTERVAL_MS = 86_400_000;

async function main(): Promise<void> {
  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory,
    matchLogPublicBaseUrl: process.env.MATCH_LOG_PUBLIC_BASE_URL,
    // eslint-disable-next-line no-console
    logEvent: (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
  });

  // One explicit line stating the resolved cadence, so a misconfiguration
  // (interval set on one process only, or an invalid value) is visible in
  // logs instead of only as a slowly-drifting UI countdown.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(
    worldTickIntervalMs !== null
      ? { msg: 'world tick cadence resolved', mode: 'interval', everyMsPerDay: worldTickIntervalMs }
      : { msg: 'world tick cadence resolved', mode: 'cron', pattern: worldTickCron },
  ));

  // First boot of a fresh database: create the world clock at S1W1.
  if (!(await deps.worlds.findById(WorldId(worldId)))) {
    await deps.worlds.save(GameWorld.create(WorldId(worldId), { season: 1, week: 1 }));
  }

  // maxRetriesPerRequest: null is required by BullMQ for blocking workers.
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const worldQueue = new Queue(WORLD_QUEUE, { connection });

  // Clean up schedulers left by older worker versions BEFORE registering
  // the current ones (see reconcileSchedulers.ts): `upsertJobScheduler`
  // never removes a renamed/retired schedule, so a stale
  // `advance-world-week` would otherwise keep firing jobs with an old
  // `worldId` at this very queue and logging `job failed`. Best-effort;
  // a cleanup miss is logged, never fatal.
  const legacyMatchesQueue = new Queue(LEGACY_MATCHES_QUEUE, { connection });
  await removeLegacySchedulers(
    [
      { queueName: WORLD_QUEUE, queue: worldQueue, schedulerIds: LEGACY_WORLD_SCHEDULERS },
      { queueName: LEGACY_MATCHES_QUEUE, queue: legacyMatchesQueue, schedulerIds: LEGACY_MATCHES_SCHEDULERS },
    ],
    (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
  );
  await legacyMatchesQueue.close();

  // Repeatable schedule (upsert = safe across restarts/deploys).
  // worldTickIntervalMs set = dev/test override (every: ms); unset =
  // production default (pattern: worldTickCron). One firing = one game
  // day; match simulation + weekly work are folded into the handler.
  const worldRepeatOptions = worldTickIntervalMs !== null ? { every: worldTickIntervalMs } : { pattern: worldTickCron };
  await worldQueue.upsertJobScheduler('advance-world-day', worldRepeatOptions, {
    name: 'advance-world-day',
    data: { worldId } satisfies AdvanceWorldJobData,
  });

  const advanceWorld = makeAdvanceWorldHandler(deps, worldTickIntervalMs);

  const workers = [
    new Worker<AdvanceWorldJobData>(WORLD_QUEUE, async (job) => advanceWorld(job.data), { connection }),
  ];
  const queues: Queue[] = [worldQueue];

  // Notifications (STAGE 2): its OWN queue + scheduler, only when a real
  // digest mode is configured. In the default 'off' mode nothing is
  // registered and no email path can run — the fail-safe direction.
  const notificationEmailMode = deps.notificationEmailMode;
  if (notificationEmailMode !== 'off') {
    const notificationsQueue = new Queue(NOTIFICATIONS_QUEUE, { connection });
    queues.push(notificationsQueue);

    const digestIntervalMsRaw = process.env.NOTIFICATION_DIGEST_INTERVAL_MS;
    const digestIntervalMs = digestIntervalMsRaw ? Number(digestIntervalMsRaw) : DEFAULT_NOTIFICATION_DIGEST_INTERVAL_MS;
    if (!Number.isFinite(digestIntervalMs) || digestIntervalMs <= 0) {
      throw new Error(`NOTIFICATION_DIGEST_INTERVAL_MS must be a positive number of milliseconds, got "${digestIntervalMsRaw}"`);
    }

    // upsert = safe across restarts/deploys, same as the world scheduler.
    await notificationsQueue.upsertJobScheduler('send-manager-digests', { every: digestIntervalMs }, {
      name: 'send-manager-digests',
    });

    const sendManagerDigests = makeSendManagerDigestsHandler(deps);
    workers.push(new Worker(NOTIFICATIONS_QUEUE, async () => sendManagerDigests(), { connection }));

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: 'notification digest scheduler registered', everyMs: digestIntervalMs }));
  }

  // One explicit line stating the resolved mode, mirroring the cadence
  // log above — so a silent `off` (or a mismatch with apps/api) is visible.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: 'notification email mode resolved', mode: notificationEmailMode }));

  for (const worker of workers) {
    worker.on('completed', (job, result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ msg: 'job completed', queue: worker.name, job: job.name, result }));
    });
    worker.on('failed', (job, error) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ msg: 'job failed', queue: worker.name, job: job?.name, error: error.message }));
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: 'worker up',
      worldTick: worldTickIntervalMs !== null ? { mode: 'interval', everyMsPerDay: worldTickIntervalMs } : { mode: 'cron', pattern: worldTickCron },
      notificationEmailMode,
      worldId,
      matchLogDirectory,
    }),
  );

  const shutdown = async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(queues.map((queue) => queue.close()));
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
