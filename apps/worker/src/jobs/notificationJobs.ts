import { Dependencies } from '@tennis-manager/api';
import { isoDayTickKey } from '../tickKey';

/**
 * Notifications bounded context (STAGE 2) — the scheduled digest
 * handler. Deliberately its OWN job on its OWN `notifications` queue,
 * NOT part of the frozen `advance-world-day` handler: a digest send is
 * a slow external HTTP call and must never be able to stall or fail the
 * world tick, and the world tick must never be the thing that
 * accidentally emails every manager.
 *
 * The window key is the real-world UTC day (isoDayTickKey, the same
 * helper the day tick uses), so the delivery ledger's composite PK makes
 * "at most one digest per manager per day" structural — two firings on
 * the same day (a retry, an overlapping schedule) collapse to one send.
 * `now` is read once and passed down so the cursor and the delivered
 * window can't straddle a millisecond boundary.
 */
export function makeSendManagerDigestsHandler(deps: Dependencies) {
  return async () => {
    const now = new Date();
    const windowKey = isoDayTickKey(now);
    return deps.notificationDigest.execute({ now, windowKey });
  };
}
