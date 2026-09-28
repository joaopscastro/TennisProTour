import { addWeeks, GameWeek, PlayerId, Tournament, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, TournamentRepository } from '../ports/ports';

/** How many upcoming weeks the planner shows when a caller doesn't ask
 * for a specific span — enough to plan a few weeks out without the
 * response growing unbounded. A caller (the HTTP route) may override
 * this via a query param; this is only the default. */
export const DEFAULT_PLANNER_WEEKS = 6;

export interface PlannerWeek {
  week: GameWeek;
  /** Every tournament the player is entered in that's scheduled for
   * this exact week — usually 0 or 1 for the senior tour (no weekly
   * cap there), up to JUNIOR_WEEKLY_ENTRY_CAP for junior tiers. An
   * empty array is a real, expected answer ("no entries this week"),
   * not an error. */
  entries: Tournament[];
}

/**
 * The multi-week planner read: given a player, what are they entered
 * in across the next several upcoming weeks, in ONE response — what a
 * frontend planner UI needs to show "week 2: nothing yet, week 3: J100
 * Open, week 4: nothing yet" without firing one request per week.
 *
 * Deliberately reuses `TournamentRepository.findByPlayerAndWeek` — the
 * exact same per-week, exact season+week query the junior weekly-cap
 * check (`countJuniorEntriesForWeek`) and `StartDueTournamentsUseCase`'s
 * weekly-commitment exclusion already read, so "what is this player
 * doing in week N" always means the same thing everywhere in this
 * codebase, never a second, possibly-drifted definition. One call per
 * week in the window, not a single cleverer bulk query — the
 * repository port doesn't expose a bulk "entries across many weeks"
 * method, and this keeps every entry point in the codebase agreeing on
 * exactly what "a player's week N" means.
 */
export class PlayerEntryPlannerQuery {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly worlds: GameWorldRepository,
  ) {}

  /** `startWeek` defaults to the world's current week (inclusive) —
   * `pastWeeks` (default 0) pushes that start BACKWARD by N weeks, so a
   * caller that must keep a LIVE entry visible even when its event's
   * label is already in the past (a 14-day major's main draw spilling
   * into the following week, a late-running draw) can ask for it. The
   * planner itself stays date-agnostic: it returns whatever weeks the
   * caller asks for, and the caller decides whether an entry is still
   * alive (the digest's `tournamentConcluded` is exactly that filter).
   * Without this, a past-labelled live event silently vanished from the
   * digest's `pendingEntries` the moment its week passed — the "week-2
   * juniors that played in week 3 vanished" bug. */
  async forPlayer(
    worldId: WorldId,
    playerId: PlayerId,
    weeksAhead: number = DEFAULT_PLANNER_WEEKS,
    startWeek?: GameWeek,
    pastWeeks: number = 0,
  ): Promise<PlannerWeek[]> {
    const world = await this.worlds.findById(worldId);
    if (!world) throw new Error(`Game world ${worldId} not found`);
    const from = addWeeks(startWeek ?? world.currentWeek, -Math.max(0, Math.trunc(pastWeeks)));

    const result: PlannerWeek[] = [];
    for (let i = 0; i < weeksAhead; i++) {
      const week = addWeeks(from, i);
      const entries = await this.tournaments.findByPlayerAndWeek(playerId, week);
      result.push({ week, entries });
    }
    return result;
  }
}
