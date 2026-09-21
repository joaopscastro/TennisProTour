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

/**
 * The earliest not-yet-started tournament across a player's planner weeks.
 * Reuses the existing GET /players/:id/entry-planner read (no new backend
 * concept) and only counts entries whose draw hasn't been made — once a
 * tournament starts, the real "next match" read takes over. Pure and total, so
 * it is unit-testable without a browser.
 */
export function nextPendingEntry(planner: PlannerWeekDto[] | null | undefined): PendingEntry | null {
  if (!planner) return null;
  let best: { key: number; entry: PlannerWeekDto['entries'][number]; week: { season: number; week: number } } | null = null;
  for (const w of planner) {
    for (const t of w.entries) {
      if (t.hasStarted) continue;
      const key = w.week.season * 52 + w.week.week;
      if (!best || key < best.key) best = { key, entry: t, week: w.week };
    }
  }
  return best ? { tournamentId: best.entry.id, name: best.entry.name, tier: best.entry.tier, week: best.week } : null;
}
