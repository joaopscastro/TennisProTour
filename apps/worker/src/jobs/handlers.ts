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
    return deps.advanceWorldWeek.execute({ worldId: WorldId(data.worldId), tickKey });
  };
}

export function makeSimulateDueMatchesHandler(deps: Dependencies) {
  return async () => deps.simulateDueMatches.execute();
}
