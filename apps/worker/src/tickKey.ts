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
