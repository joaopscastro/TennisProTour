import { WorldId } from '@tennis-manager/domain';
import { Dependencies } from '@tennis-manager/api';
import { isoWeekTickKey } from '../tickKey';

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

export function makeAdvanceWorldHandler(deps: Dependencies) {
  return async (data: AdvanceWorldJobData) => {
    const tickKey = data.tickKey ?? isoWeekTickKey(new Date());
    const worldId = WorldId(data.worldId);
    const result = await deps.advanceWorldWeek.execute({ worldId, tickKey });
    // Talent pool refresh piggybacks on the SAME weekly tick as aging,
    // gated on `advanced` rather than carrying its own idempotency
    // key — a duplicate/retried tick that didn't actually move the
    // world clock forward shouldn't refresh the pool either. See
    // RefreshTalentPoolUseCase's doc comment.
    if (result.advanced) {
      await deps.refreshTalentPool.execute({ worldId });
      // Weekly junior-tournament generation piggybacks on the same
      // tick/gate as the talent pool refresh above, for the same
      // reason: a duplicate/retried tick that didn't actually move
      // the world clock forward shouldn't generate a fresh batch of
      // tournaments either. See GenerateJuniorTournamentsUseCase.
      await deps.generateJuniorTournaments.execute({ worldId });
      // Runs AFTER junior generation, same tick/gate, for a load-bearing
      // reason, not just consistency: StartDueTournamentsUseCase's due
      // check is strictly `weeksBetween(weekScheduled, currentWeek) > 0`
      // specifically so a junior tournament opened moments ago THIS
      // tick (weekScheduled: currentWeek) is never force-started before
      // any manager had a chance to register — see that use case's own
      // doc comment.
      await deps.startDueTournaments.execute({ worldId });
    }
    return result;
  };
}

export function makeSimulateDueMatchesHandler(deps: Dependencies) {
  return async () => deps.simulateDueMatches.execute();
}
