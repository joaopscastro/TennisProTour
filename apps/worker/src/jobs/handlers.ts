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
    }
    return result;
  };
}

export function makeSimulateDueMatchesHandler(deps: Dependencies) {
  return async () => deps.simulateDueMatches.execute();
}
