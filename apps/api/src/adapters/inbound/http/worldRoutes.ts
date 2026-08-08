import { FastifyInstance } from 'fastify';
import { parseExpression } from 'cron-parser';
import { Dependencies, WORLD_ID } from '../../../composition';

/**
 * Audit finding (see CLAUDE.md): apps/worker schedules the weekly tick
 * as a BullMQ repeatable job entirely internal to its own Redis
 * connection — apps/api has no Redis/BullMQ client and never did.
 * Rather than give the API a second connection to Redis purely to ask
 * "when does this job next run," this route recomputes the same
 * answer from the same cron string apps/worker reads, via cron-parser
 * (already a transitive dependency of bullmq, added here directly).
 * This DOES mean WORLD_TICK_CRON must be kept identical between the
 * two processes — the same disclosed coupling CLAUDE.md already
 * documents for WORLD_ID matching across apps/api and apps/worker.
 */
export function registerWorldRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get('/world/clock', async () => {
    const world = await deps.worlds.findById(WORLD_ID);
    if (!world) throw new Error('World not found');
    const cron = process.env.WORLD_TICK_CRON ?? '0 3 * * 1';
    // No tz option: matches BullMQ's own default (cron-parser against the
    // process's local system time) since apps/worker's upsertJobScheduler
    // call doesn't pass a tz either — both processes run in UTC containers.
    const nextTickAt = parseExpression(cron).next().toDate();
    return {
      currentWeek: world.currentWeek,
      nextTickAt: nextTickAt.toISOString(),
    };
  });
}
