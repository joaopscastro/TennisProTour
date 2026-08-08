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
   * the planner always starts from "now," never the past, unless a
   * caller explicitly asks otherwise. */
  async forPlayer(
    worldId: WorldId,
    playerId: PlayerId,
    weeksAhead: number = DEFAULT_PLANNER_WEEKS,
    startWeek?: GameWeek,
  ): Promise<PlannerWeek[]> {
    const world = await this.worlds.findById(worldId);
    if (!world) throw new Error(`Game world ${worldId} not found`);
    const from = startWeek ?? world.currentWeek;

    const result: PlannerWeek[] = [];
    for (let i = 0; i < weeksAhead; i++) {
      const week = addWeeks(from, i);
      const entries = await this.tournaments.findByPlayerAndWeek(playerId, week);
      result.push({ week, entries });
    }
    return result;
  }
}
