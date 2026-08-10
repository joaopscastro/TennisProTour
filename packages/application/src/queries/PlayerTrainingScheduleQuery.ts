import { addWeeks, GameWeek, PlayerId, resolveTrainingFocusForWeek, TrainingFocus, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, TrainingScheduleRepository } from '../ports/ports';
import { DEFAULT_PLANNER_WEEKS } from './PlayerEntryPlannerQuery';

export interface TrainingScheduleWeek {
  week: GameWeek;
  /** The resolved effective focus for this week — an explicit entry
   * for this exact week, or the carried-forward standing order from
   * the most recent earlier one, or null if no order has ever been
   * given yet by this week (see resolveTrainingFocusForWeek). */
  focus: TrainingFocus | null;
  /** True when this week has its OWN explicit schedule entry — the
   * week where the standing order actually changes, as opposed to one
   * simply carrying an earlier order forward. The frontend uses this
   * to distinguish "editing this week creates a new explicit entry
   * here" from "this week is just showing what's already in effect". */
  isExplicit: boolean;
}

/**
 * The multi-week training-focus planner read — the training-schedule
 * mirror of PlayerEntryPlannerQuery, deliberately built the same
 * shape (same DEFAULT_PLANNER_WEEKS window, same "one read covering N
 * upcoming weeks in one response" reasoning) so a frontend Schedule
 * view can zip this together with PlayerEntryPlannerQuery's own
 * per-week results week-for-week. This is intentionally a SEPARATE
 * query against a separate repository, not a merge of the two into
 * one new backend concept — the combined view is a frontend concern
 * (see apps/web/app/players/[id]/page.tsx's Schedule section), Step 2
 * of this feature reuses these two existing/parallel backend reads
 * rather than inventing a third.
 */
export class PlayerTrainingScheduleQuery {
  constructor(
    private readonly schedule: TrainingScheduleRepository,
    private readonly worlds: GameWorldRepository,
  ) {}

  /** `startWeek` defaults to the world's current week (inclusive) —
   * same default PlayerEntryPlannerQuery.forPlayer uses, so the two
   * queries agree on which week window "the next N weeks" means
   * without either caller having to coordinate it. */
  async forPlayer(
    worldId: WorldId,
    playerId: PlayerId,
    weeksAhead: number = DEFAULT_PLANNER_WEEKS,
    startWeek?: GameWeek,
  ): Promise<TrainingScheduleWeek[]> {
    const world = await this.worlds.findById(worldId);
    if (!world) throw new Error(`Game world ${worldId} not found`);
    const from = startWeek ?? world.currentWeek;

    const entries = await this.schedule.findByPlayer(playerId);
    const explicitWeeks = new Set(entries.map((e) => `${e.effectiveFrom.season}-${e.effectiveFrom.week}`));

    const result: TrainingScheduleWeek[] = [];
    for (let i = 0; i < weeksAhead; i++) {
      const week = addWeeks(from, i);
      result.push({
        week,
        focus: resolveTrainingFocusForWeek(entries, week),
        isExplicit: explicitWeeks.has(`${week.season}-${week.week}`),
      });
    }
    return result;
  }
}
