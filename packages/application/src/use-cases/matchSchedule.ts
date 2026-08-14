import { MatchLog } from '@tennis-manager/domain';

/**
 * The staggered-match-schedule model (the "live following" feature).
 *
 * A world tick advances the game one DAY; the matches due that day are
 * all pre-simulated at the tick (principle #4 — synchronous, no
 * WebSockets), but instead of all "airing" at once, each is assigned a
 * scheduled reveal start staggered across the day and its replay log is
 * time-scaled to a reveal window, so a match starts AND ends within the
 * day. The bracket shows a live countdown to a match's start; once
 * started, a manager follows the already-decided result unfold point by
 * point via the existing MatchReplayPlayer, whose wall-clock "Premiere"
 * cap is anchored to the match's `simulatedAt` (= its scheduled start).
 *
 * The reveal window is DERIVED from the day length, not a fixed constant:
 * a round's matches divide the day evenly (`revealWindowSecondsFor`), so
 * they tile the day exactly and the "starts and ends within the day"
 * invariant holds for any draw size and any day length (prod's 24-hour
 * cron day or a fast dev `WORLD_TICK_INTERVAL_MS`). A lone match (e.g. a
 * final) would otherwise claim the whole day, so the window is capped at
 * MATCH_REVEAL_CAP_SECONDS. All constants are PLACEHOLDER values.
 */
export const MATCH_REVEAL_CAP_SECONDS = 900;
/** The production day window (one cron day = 24h). Used when the worker
 * runs on the default cron rather than WORLD_TICK_INTERVAL_MS. */
export const DEFAULT_DAY_WINDOW_SECONDS = 86400;

/** The real-time reveal window for one round's matches — the day window
 * divided evenly among them, capped so a sparse round (a final) doesn't
 * drag for a full day. Matches stagger by exactly this amount, so a round
 * tiles the day and every match starts AND ends within it. */
export function revealWindowSecondsFor(matchesInRound: number, dayWindowSeconds: number): number {
  const even = Math.floor(dayWindowSeconds / Math.max(1, matchesInRound));
  return Math.max(1, Math.min(MATCH_REVEAL_CAP_SECONDS, even));
}

/** The scheduled reveal start for the match at `matchIndex` (0-based)
 * within its round, anchored to `anchorMs` (the day tick's wall-clock
 * time). Matches in the SAME round stagger by `revealSeconds`; different
 * tournaments' rounds overlap, exactly like real tennis. */
export function scheduledStartAtFor(matchIndex: number, revealSeconds: number, anchorMs: number): string {
  return new Date(anchorMs + matchIndex * revealSeconds * 1000).toISOString();
}

/**
 * Time-scales a fully-simulated replay log so its whole content (whatever
 * the match's natural `totalDurationSeconds` was) unfolds over exactly
 * `revealDurationSeconds` of real time — the honest way to guarantee a
 * match "starts AND ends within the day" regardless of how long the
 * simulator says the match took. `offsetSeconds` values (point-by-point
 * and game rollup) are rescaled monotonically; `totalDurationSeconds`
 * becomes the reveal window so MatchReplayPlayer's existing 1:1
 * wall-clock pacing caps correctly.
 */
export function scaleMatchLogToReveal(
  log: Omit<MatchLog, 'simulatedAt'>,
  revealDurationSeconds: number,
): Omit<MatchLog, 'simulatedAt'> {
  const total = log.totalDurationSeconds;
  if (total <= 0 || revealDurationSeconds <= 0) return log;
  const factor = revealDurationSeconds / total;
  const scale = (seconds: number): number => Math.max(0, Math.round(seconds * factor));
  return {
    ...log,
    totalDurationSeconds: revealDurationSeconds,
    entries: log.entries.map((entry) => ({ ...entry, offsetSeconds: scale(entry.offsetSeconds) })),
    points: log.points.map((point) => ({ ...point, offsetSeconds: scale(point.offsetSeconds) })),
  };
}
