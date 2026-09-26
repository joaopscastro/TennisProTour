import type { PlannerWeekDto } from './api';

/**
 * A tournament a player is registered in whose draw hasn't been made yet — the
 * honest "your entry worked" cue a roster row was missing. An entered-but-not-
 * drawn event has no match to show, so the row used to read "No match
 * scheduled" and look like the entry had failed.
 */
export interface PendingEntry {
  tournamentId: string;
  name: string;
  tier: string;
  week: { season: number; week: number };
}

/** A tournament the player was entered in that was CANCELLED before it
 * ever started (P1-C1/C3). It is still shown — hidden entries read as
 * data loss — but plainly as "Cancelled", with the reason, and it is
 * never counted as a pending commitment. */
export interface CancelledEntry extends PendingEntry {
  reason: string | null;
}

const absoluteWeek = (week: { season: number; week: number }): number => week.season * 52 + week.week;

/**
 * The earliest not-yet-started tournament across a player's planner weeks.
 * Reuses the existing GET /players/:id/entry-planner read (no new backend
 * concept) and only counts entries whose draw hasn't been made — once a
 * tournament starts, the real "next match" read takes over. A CANCELLED
 * draw is excluded (it will never be made, so it is not a commitment; see
 * latestCancelledEntry for how it is surfaced instead). Pure and total, so
 * it is unit-testable without a browser.
 */
export function nextPendingEntry(planner: PlannerWeekDto[] | null | undefined): PendingEntry | null {
  if (!planner) return null;
  let best: { key: number; entry: PlannerWeekDto['entries'][number]; week: { season: number; week: number } } | null = null;
  for (const w of planner) {
    for (const t of w.entries) {
      if (t.hasStarted || t.cancelled) continue;
      const key = absoluteWeek(w.week);
      if (!best || key < best.key) best = { key, entry: t, week: w.week };
    }
  }
  return best ? { tournamentId: best.entry.id, name: best.entry.name, tier: best.entry.tier, week: best.week } : null;
}

/**
 * The MOST RECENT cancelled entry across a player's planner weeks — the
 * roster uses it to say "Cancelled: <name> — <reason>" when there is no
 * live pending entry to show, so a cancellation never silently reads as
 * "No match scheduled". Returns null when nothing was cancelled in the
 * window. Pure, like nextPendingEntry.
 */
export function latestCancelledEntry(planner: PlannerWeekDto[] | null | undefined): CancelledEntry | null {
  if (!planner) return null;
  let best: { key: number; entry: PlannerWeekDto['entries'][number]; week: { season: number; week: number } } | null = null;
  for (const w of planner) {
    for (const t of w.entries) {
      if (!t.cancelled) continue;
      const key = absoluteWeek(w.week);
      if (!best || key > best.key) best = { key, entry: t, week: w.week };
    }
  }
  return best
    ? {
        tournamentId: best.entry.id,
        name: best.entry.name,
        tier: best.entry.tier,
        week: best.week,
        reason: best.entry.cancelReason,
      }
    : null;
}
