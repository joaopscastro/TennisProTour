import { ConcurrentModificationError } from '../ports/ports';

/**
 * Bounded optimistic-retry wrapper for write flows that can lose the
 * tournament optimistic lock (see ConcurrentModificationError /
 * Tournament.persistenceVersion). The version guard is correctness, not
 * the feature: when two managers register for the same tournament at
 * the same moment, the loser's whole-aggregate `save` is (rightly)
 * refused — but silently giving up would LOSE that manager's entry, and
 * the 52-week agent season measured exactly that (49 conflicts, 9
 * entries permanently lost, including two majors). The conflict is
 * inherently retryable: reloading the tournament and re-applying the
 * SAME single-entrant command against the winner's committed state
 * produces the correct combined outcome.
 *
 * Every rule must therefore be re-evaluated inside the retried closure
 * (the registration use cases wrap their ENTIRE load → rules → mutate →
 * save flow, not just the save), so a reload sees the winner's entry:
 * the weekly cap, age/band eligibility, rank restriction, qualifying
 * capacity and `[Q]`/wild-card slots all re-decide against fresh state,
 * and the "last slot just filled" auto-start fires when appropriate.
 * Replaying the flow is safe because every other write it makes is
 * idempotent for the same (player, tournament): the weekly-cap claim's
 * atomic guard excludes the tournament being registered from its own
 * count and inserts `onConflictDoNothing`; `applyWildCards` only mutates
 * in memory until the successful save.
 *
 * Deliberately bounded (~4 attempts with a short jittered backoff): a
 * generator of conflicts this long-lived is a real problem worth
 * surfacing, not an invitation to spin forever. Once the attempts are
 * exhausted the ORIGINAL ConcurrentModificationError is rethrown — the
 * route's provisional mapping still turns that into a retryable 409.
 */
export interface RetryOnConflictOptions {
  /** Total attempts, including the first. Default 4. */
  attempts?: number;
  /** First backoff delay; doubles each retry, capped at maxDelayMs.
   * Default 25ms. */
  baseDelayMs?: number;
  /** Delay cap. Default 200ms. */
  maxDelayMs?: number;
  /** 0..1 source for the jitter applied to each delay (the delay is
   * multiplied by 0.5..1.0). Injectable for deterministic tests. */
  random?: () => number;
  /** Injectable sleep, so unit tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_ON_CONFLICT_ATTEMPTS = 4;

export async function retryOnConflict<T>(
  operation: () => Promise<T>,
  options: RetryOnConflictOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY_ON_CONFLICT_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`retryOnConflict requires at least one attempt, got ${attempts}`);
  }
  const baseDelayMs = options.baseDelayMs ?? 25;
  const maxDelayMs = options.maxDelayMs ?? 200;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      // Only the retryable optimistic-lock conflict is swallowed; every
      // rule violation (409) and not-found (404) propagates untouched.
      if (!(error instanceof ConcurrentModificationError)) throw error;
      lastError = error;
      if (attempt === attempts) break;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.max(1, Math.round(backoff * (0.5 + 0.5 * random())));
      await sleep(jittered);
    }
  }
  throw lastError;
}
