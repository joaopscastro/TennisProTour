/**
 * The idempotency key for a weekly world tick: the real-world ISO
 * 8601 week (e.g. "2026-W31") the scheduler fired in. Every firing
 * within the same real week — including BullMQ retries and duplicate
 * schedulers — produces the same key, which GameWorld.advanceWeek()
 * refuses to apply twice. One real week => one game week, per world.
 */
export function isoWeekTickKey(date: Date): string {
  // ISO week: Thursday of the current week decides the week-year.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = target.getUTCDay() || 7; // Mon=1 .. Sun=7
  target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The idempotency key for a weekly world tick when the scheduler runs
 * on a configurable WORLD_TICK_INTERVAL_MS (see index.ts) instead of
 * the default real-week cron. `isoWeekTickKey` can't be reused here:
 * it produces the SAME key for every firing within one real calendar
 * week, which is exactly right when one tick = one real week, but
 * would silently no-op every firing after the first if the scheduler
 * is firing hourly for fast dev/test cycles — the whole point of the
 * override would be defeated. This buckets real time into
 * intervalMs-sized slots instead: same "one bucket, one tick"
 * idempotency shape as isoWeekTickKey (a genuine retry landing in the
 * same slot still collapses to one key), just parameterized by
 * whatever interval is actually configured rather than hardcoded to
 * calendar weeks.
 */
export function intervalTickKey(date: Date, intervalMs: number): string {
  return `interval-${Math.floor(date.getTime() / intervalMs)}`;
}

/**
 * The idempotency key for a DAY world tick on the default (non-interval)
 * cadence: the real-world UTC calendar date (e.g. "2026-01-15"). Every
 * firing within the same real day — including BullMQ retries and
 * duplicate schedulers — produces the same key, which
 * GameWorld.advanceDay() refuses to apply twice. One real day => one
 * game day, per world. Replaces isoWeekTickKey as the scheduled-tick
 * key now that one tick advances a single day rather than a whole week
 * (isoWeekTickKey would collapse all 7 days of a real week to one key,
 * no-opping days 2-7).
 */
export function isoDayTickKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
