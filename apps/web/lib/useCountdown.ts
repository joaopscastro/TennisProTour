'use client';

import { useEffect, useState } from 'react';

/** Ticks once a second against a fixed target timestamp, purely
 * client-side — no re-fetch needed to stay accurate, since the target
 * itself (nextTickAt) doesn't move between world-clock fetches. Shared
 * by the Sidebar's world clock and the Scouting page's "next refresh"
 * countdown so both read the same countdown mechanics, not two
 * independently-written setInterval loops. */
export function useCountdown(target: string | null): number {
  const [remainingMs, setRemainingMs] = useState(() => (target ? new Date(target).getTime() - Date.now() : 0));

  useEffect(() => {
    if (!target) return;
    const targetMs = new Date(target).getTime();
    const tick = () => setRemainingMs(Math.max(0, targetMs - Date.now()));
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
