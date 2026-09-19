'use client';

import { useEffect, useRef, useState } from 'react';

/** How often an already-expired target re-triggers `onExpire` while it
 * remains expired. At the default daily cadence a countdown reaching zero
 * and sticking was invisible; at the compressed 2h/day production cadence
 * every open tab would freeze within hours, because a countdown can only
 * ever count toward a FIXED timestamp and the page fetched it once. The
 * callback lets the caller re-fetch the source. Retrying keeps recovery
 * eventual even if the re-fetch lands a moment before the worker actually
 * applies the tick (which returns the same now-past timestamp), while
 * being long enough not to hammer a genuinely stalled worker. */
const EXPIRE_RETRY_MS = 10_000;

/** Ticks once a second against a fixed target timestamp, purely
 * client-side. `onExpire` (optional) fires when the target passes — throttled
 * to at most once per `EXPIRE_RETRY_MS` — so a caller can re-fetch whatever
 * produced the target and unfreeze an open tab. Shared by the Sidebar's
 * world clock and the Scouting page's "next refresh" countdown so both read
 * the same countdown mechanics, not two independently-written setInterval
 * loops. */
export function useCountdown(target: string | null, onExpire?: () => void): number {
  const [remainingMs, setRemainingMs] = useState(() => (target ? new Date(target).getTime() - Date.now() : 0));
  // Kept in a ref (synced in its own effect, declared before the ticking
  // effect so it always runs first) so a caller passing an inline closure
  // doesn't restart the interval every render.
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });
  const lastExpireFireRef = useRef(0);

  useEffect(() => {
    if (!target) return;
    const targetMs = new Date(target).getTime();
    const tick = () => {
      const remaining = Math.max(0, targetMs - Date.now());
      setRemainingMs(remaining);
      if (remaining <= 0) {
        const now = Date.now();
        if (now - lastExpireFireRef.current >= EXPIRE_RETRY_MS) {
          lastExpireFireRef.current = now;
          onExpireRef.current?.();
        }
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [target]);

  return Math.max(0, remainingMs);
}

/** "2d 4h 12m", dropping to "4h 12m 03s" inside the final day for a
 * more precise sense of imminence — mirrors how the rest of this app's
 * countdown-adjacent copy (roster stageNote) favors coarse buckets
 * until something is close enough to matter more precisely. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** "00:03:45" (or "1:02:03" past an hour) — the tight clock format the
 * "playing in X" match countdown uses, distinct from formatCountdown's
 * coarse "4h 12m" buckets. */
export function formatCountdownClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
