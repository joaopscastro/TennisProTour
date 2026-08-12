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
import { buildDependencies, createDb } from '@tennis-manager/api';
import { AdvanceWorldJobData, makeAdvanceWorldHandler } from './jobs/handlers';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const matchLogDirectory = process.env.MATCH_LOG_DIR ?? './data/match-logs';
const worldId = process.env.WORLD_ID ?? 'main';
// World tick is now one game DAY per firing (see
// docs/day-tick-and-scheduling.md). Default: daily 03:00 UTC. Match
// simulation and weekly work are both folded into this single tick — a
// week is 7 day-ticks, and the heavy weekly systems fire on the 7->1
// rollover only. There is no separate match-sweep job anymore.
const worldTickCron = process.env.WORLD_TICK_CRON ?? '0 3 * * *';

/**
 * Dev/test override: fire the world tick every N milliseconds instead
 * of the real-week cron above — e.g. WORLD_TICK_INTERVAL_MS=3600000
 * for an hourly cadence so aging/training/tournament generation are
 * actually observable in a normal working session. With the day tick,
 * this is now MS-PER-DAY: a dev game-week is 7 x this value. Unset (the
 * production default) keeps worldTickCron in full control, byte-for-byte
 * the same behavior as before this override existed. See README.md's
 * "Fast local tick cadence" section.
 */
const worldTickIntervalMsRaw = process.env.WORLD_TICK_INTERVAL_MS;
const worldTickIntervalMs = worldTickIntervalMsRaw ? Number(worldTickIntervalMsRaw) : null;
if (worldTickIntervalMsRaw !== undefined && (!Number.isFinite(worldTickIntervalMs) || (worldTickIntervalMs as number) <= 0)) {
  throw new Error(`WORLD_TICK_INTERVAL_MS must be a positive number of milliseconds, got "${worldTickIntervalMsRaw}"`);
}

const WORLD_QUEUE = 'world';

async function main(): Promise<void> {
  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory,
    matchLogPublicBaseUrl: process.env.MATCH_LOG_PUBLIC_BASE_URL,
    // eslint-disable-next-line no-console
    logEvent: (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
  });

  // First boot of a fresh database: create the world clock at S1W1.
  if (!(await deps.worlds.findById(WorldId(worldId)))) {
    await deps.worlds.save(GameWorld.create(WorldId(worldId), { season: 1, week: 1 }));
  }

  // maxRetriesPerRequest: null is required by BullMQ for blocking workers.
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const worldQueue = new Queue(WORLD_QUEUE, { connection });

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
      worldId,
    }),
  );

  const shutdown = async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await worldQueue.close();
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
