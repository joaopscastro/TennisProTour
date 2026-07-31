import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { GameWorld, WorldId } from '@tennis-manager/domain';
import { buildDependencies, createDb } from '@tennis-manager/api';
import { AdvanceWorldJobData, makeAdvanceWorldHandler, makeSimulateDueMatchesHandler } from './jobs/handlers';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const matchLogDirectory = process.env.MATCH_LOG_DIR ?? './data/match-logs';
const worldId = process.env.WORLD_ID ?? 'main';
// Weekly world tick: Mondays 03:00 UTC. Every-5-min match sweep.
const worldTickCron = process.env.WORLD_TICK_CRON ?? '0 3 * * 1';
const matchSweepCron = process.env.MATCH_SWEEP_CRON ?? '*/5 * * * *';

const WORLD_QUEUE = 'world';
const MATCHES_QUEUE = 'matches';

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
  const matchesQueue = new Queue(MATCHES_QUEUE, { connection });

  // Repeatable schedules (upsert = safe across restarts/deploys).
  await worldQueue.upsertJobScheduler('advance-world-week', { pattern: worldTickCron }, {
    name: 'advance-world-week',
    data: { worldId } satisfies AdvanceWorldJobData,
  });
  await matchesQueue.upsertJobScheduler('simulate-due-matches', { pattern: matchSweepCron }, {
    name: 'simulate-due-matches',
  });

  const advanceWorld = makeAdvanceWorldHandler(deps);
  const simulateDue = makeSimulateDueMatchesHandler(deps);

  const workers = [
    new Worker<AdvanceWorldJobData>(WORLD_QUEUE, async (job) => advanceWorld(job.data), { connection }),
    new Worker(MATCHES_QUEUE, async () => simulateDue(), { connection }),
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
  console.log(JSON.stringify({ msg: 'worker up', worldTickCron, matchSweepCron, worldId }));

  const shutdown = async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all([worldQueue.close(), matchesQueue.close()]);
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
