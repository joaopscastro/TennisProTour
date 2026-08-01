#!/usr/bin/env node
// Confirms apps/worker actually registered its two repeatable job
// schedulers in Redis. Used by scripts/boot-smoke-test.sh — a worker
// process that's merely "still running" could have silently failed
// its upsertJobScheduler() calls (e.g. bad Redis connection options),
// so this checks the real BullMQ state, not just process liveness.
// Exits 0 once both schedulers are present, 1 otherwise.
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Must match apps/worker/src/index.ts: queue name -> scheduler id.
const EXPECTED = {
  world: 'advance-world-week',
  matches: 'simulate-due-matches',
};

async function schedulerExists(connection, queueName, schedulerId) {
  const queue = new Queue(queueName, { connection });
  try {
    const schedulers = await queue.getJobSchedulers();
    return schedulers.some((scheduler) => scheduler.key === schedulerId);
  } finally {
    await queue.close();
  }
}

async function main() {
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  try {
    for (const [queueName, schedulerId] of Object.entries(EXPECTED)) {
      if (!(await schedulerExists(connection, queueName, schedulerId))) {
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    connection.disconnect();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
