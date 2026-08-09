import { FastifyInstance } from 'fastify';
import { parseExpression } from 'cron-parser';
import { Dependencies, WORLD_ID } from '../../../composition';

/**
 * Audit finding (see CLAUDE.md): apps/worker schedules the weekly tick
 * as a BullMQ repeatable job entirely internal to its own Redis
 * connection — apps/api has no Redis/BullMQ client and never did.
 * Rather than give the API a second connection to Redis purely to ask
 * "when does this job next run," this route recomputes the answer
 * independently, in one of two ways depending on which mode
 * apps/worker is actually running in (see index.ts's
 * WORLD_TICK_INTERVAL_MS):
 *
 * - Cron mode (the production default): via cron-parser against the
 *   same WORLD_TICK_CRON string apps/worker reads (already a
 *   transitive dependency of bullmq, added here directly). This DOES
 *   mean WORLD_TICK_CRON must be kept identical between the two
 *   processes — the same disclosed coupling CLAUDE.md already
 *   documents for WORLD_ID matching across apps/api and apps/worker.
 * - Interval mode (WORLD_TICK_INTERVAL_MS set, e.g. for fast local dev
 *   cycles): anchored to game_worlds.updated_at (via
 *   DrizzleGameWorldRepository.findLastTickAt) plus the interval —
 *   the real wall-clock time of the last tick that ACTUALLY advanced
 *   the world (AdvanceWorldWeekUseCase only saves on a genuine
 *   advance, never a no-op re-fire), not a theoretical schedule apps/api
 *   has no way to observe directly. This is arguably more accurate
 *   than the cron path even conceptually: it self-corrects every tick
 *   from real applied-tick data instead of two processes needing to
 *   agree on an un-observable schedule.
 */
export function registerWorldRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get('/world/clock', async () => {
    const world = await deps.worlds.findById(WORLD_ID);
    if (!world) throw new Error('World not found');

    const intervalMsRaw = process.env.WORLD_TICK_INTERVAL_MS;
    const intervalMs = intervalMsRaw ? Number(intervalMsRaw) : null;

    let nextTickAt: Date;
    if (intervalMs !== null && Number.isFinite(intervalMs) && intervalMs > 0) {
      const lastTickAt = (await deps.worlds.findLastTickAt(WORLD_ID)) ?? new Date();
      nextTickAt = new Date(lastTickAt.getTime() + intervalMs);
    } else {
      const cron = process.env.WORLD_TICK_CRON ?? '0 3 * * 1';
      // No tz option: matches BullMQ's own default (cron-parser against the
      // process's local system time) since apps/worker's upsertJobScheduler
      // call doesn't pass a tz either — both processes run in UTC containers.
      nextTickAt = parseExpression(cron).next().toDate();
    }

    return {
      currentWeek: world.currentWeek,
      nextTickAt: nextTickAt.toISOString(),
    };
  });
}
