/**
 * Boot-time cleanup of job schedulers left behind by older worker
 * versions.
 *
 * WHY THIS EXISTS: BullMQ's `upsertJobScheduler` only ever ADDS/updates a
 * schedule keyed by its id — it never removes one whose id a later
 * version stopped using. When the weekly world tick was renamed to the
 * day tick (`advance-world-week` -> `advance-world-day`), and the
 * separate 5-minute match sweep (`simulate-due-matches`) was folded into
 * that same tick, both old schedulers stayed in Redis. The real-cadence
 * soak then logged repeated `job failed` for `advance-world-week` jobs,
 * because the still-running world Worker was faithfully processing the
 * stale schedule's payload (an old `worldId`) against a world that no
 * longer existed.
 *
 * An upgrade therefore has to clean up after itself explicitly. This
 * removes a known, hard-coded list of legacy scheduler ids and logs each
 * one it actually removed; it is deliberately tiny and explicit rather
 * than a "diff the whole scheduler set" sweep, so it can never delete a
 * scheduler some future version does want.
 */

/** The narrow slice of BullMQ's `Queue` this needs — kept structural so
 * the unit test can pass a plain fake with no Redis. */
export interface SchedulerQueue {
  removeJobScheduler(id: string): Promise<boolean>;
}

export interface LegacySchedulerTarget {
  /** Only used for logging. */
  queueName: string;
  queue: SchedulerQueue;
  schedulerIds: ReadonlyArray<string>;
}

/**
 * Removes every listed legacy scheduler, logging each removal. Removal
 * is best-effort: a failure is logged and does not abort boot (Redis
 * connectivity is already proven by the surrounding `upsertJobScheduler`
 * calls, and a cleanup miss is not worth failing a worker start over).
 * Idempotent — `removeJobScheduler` returns false when nothing matches,
 * which simply logs nothing.
 */
export async function removeLegacySchedulers(
  targets: ReadonlyArray<LegacySchedulerTarget>,
  log: (message: string, payload: Record<string, unknown>) => void,
): Promise<void> {
  for (const target of targets) {
    for (const schedulerId of target.schedulerIds) {
      try {
        const removed = await target.queue.removeJobScheduler(schedulerId);
        if (removed) {
          log('legacy job scheduler removed', { queue: target.queueName, schedulerId });
        }
      } catch (error) {
        log('legacy job scheduler cleanup failed', {
          queue: target.queueName,
          schedulerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
