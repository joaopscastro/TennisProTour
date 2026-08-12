import { WorldId } from '@tennis-manager/domain';
import { Dependencies } from '@tennis-manager/api';
import { intervalTickKey, isoDayTickKey } from '../tickKey';

/**
 * Thin BullMQ handlers — parse the job, call the use case, log the
 * result. All idempotency guards live below the handlers: the tick
 * key in GameWorld for aging, and the aggregate's decided-match
 * checks for simulation. A crashed/retried job therefore re-runs
 * safely without any BullMQ-level dedup configuration.
 */

export interface AdvanceWorldJobData {
  worldId: string;
  /** Present for manual/test runs; scheduled runs derive it from the
   * real-world ISO week at processing time. */
  tickKey?: string;
}

/**
 * `tickIntervalMs` mirrors whatever WORLD_TICK_INTERVAL_MS index.ts
 * resolved (null = default real-week cadence) — passed in explicitly
 * rather than read from process.env here, so this handler's tick-key
 * choice is a pure function of its arguments and stays unit-testable
 * without env-var side effects.
 */
export function makeAdvanceWorldHandler(deps: Dependencies, tickIntervalMs: number | null) {
  return async (data: AdvanceWorldJobData) => {
    const tickKey = data.tickKey ?? (tickIntervalMs !== null ? intervalTickKey(new Date(), tickIntervalMs) : isoDayTickKey(new Date()));
    const worldId = WorldId(data.worldId);
    const result = await deps.advanceWorldWeek.execute({ worldId, tickKey });

    // Weekly systems fire ONLY on a week rollover (day 7 -> 1). A
    // mid-week day tick still advances the clock (result.advanced) but
    // must not refresh the pool / generate junior tournaments / start
    // due tournaments — those stay weekly (see
    // docs/day-tick-and-scheduling.md and each use case's doc comment).
    if (result.advanced && result.weekRolledOver) {
      // Talent pool refresh piggybacks on the SAME weekly rollover as
      // aging, gated on `weekRolledOver` rather than carrying its own
      // idempotency key. See RefreshTalentPoolUseCase's doc comment.
      await deps.refreshTalentPool.execute({ worldId });
      // Weekly junior-tournament generation, same rollover/gate.
      await deps.generateJuniorTournaments.execute({ worldId });
      // Runs AFTER junior generation, same rollover/gate, for a
      // load-bearing reason: StartDueTournamentsUseCase's due check is
      // strictly `weeksBetween(weekScheduled, currentWeek) > 0` so a
      // junior tournament opened moments ago THIS rollover
      // (weekScheduled: currentWeek) is never force-started before any
      // manager had a chance to register — see that use case's doc.
      await deps.startDueTournaments.execute({ worldId });
    }

    // Match simulation is folded into EVERY day tick (not just
    // rollovers) and paced by the schedule policy: it plays only the
    // rounds whose scheduled day has arrived, one round per tournament
    // per day. See SimulateDueMatchesUseCase.
    if (result.advanced) {
      const sim = await deps.simulateDueMatches.execute({ worldId });
      return { ...result, matchesSimulated: sim.simulated.length, matchesFailed: sim.failed.length };
    }
    return result;
  };
}

export function makeSimulateDueMatchesHandler(deps: Dependencies, worldId: string) {
  return async () => deps.simulateDueMatches.execute({ worldId: WorldId(worldId) });
}
