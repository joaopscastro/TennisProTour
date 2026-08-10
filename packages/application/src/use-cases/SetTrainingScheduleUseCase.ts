import { compareGameWeek, GameWeek, PlayerId, TrainingFocus, TrainingScheduleEntry, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, TrainingScheduleRepository } from '../ports/ports';

export interface SetTrainingScheduleCommand {
  playerId: PlayerId;
  /** The week this focus becomes the standing order from (inclusive)
   * — omitted means "starting right now" (the world's current week),
   * the exact same "set and forget" UX SetTrainingFocusUseCase used to
   * offer before this feature existed. Explicit future weeks are the
   * new capability this command adds. */
  effectiveFrom?: GameWeek;
  /** null explicitly clears the standing order from effectiveFrom
   * onward ("train nothing"), same meaning as the old
   * SetTrainingFocusUseCase's null. */
  focus: TrainingFocus | null;
}

/**
 * Records one explicit training-schedule entry for a player — does
 * NOT apply any attribute delta itself, same non-goal the old
 * SetTrainingFocusUseCase had. The delta is still only ever applied
 * once per game week, inside AdvanceWorldWeekUseCase's tick, which now
 * resolves each player's effective focus from this schedule (via
 * resolveTrainingFocusForWeek) instead of reading a single mutable
 * field.
 *
 * Replaces SetTrainingFocusUseCase: renamed (not kept alongside a new
 * use case) because the semantics genuinely changed the same way
 * TrainPlayerUseCase -> SetTrainingFocusUseCase did — this one records
 * a scheduled ORDER for a specific week, not an immediate mutation of
 * "the" focus.
 *
 * Guards against scheduling a week that's already in the past (the
 * world's current week or later only) — not because the past is
 * somehow locked in the schema, but because allowing it would let a
 * manager rewrite what a resolveTrainingFocusForWeek query reports for
 * an already-elapsed week, contradicting the "changing the standing
 * order today doesn't retroactively change what already applied in
 * past weeks" guarantee (see TrainingSchedule.ts's doc comment) — that
 * guarantee only holds if every entry's effectiveFrom is honestly in
 * the present or future at the moment it's written.
 */
export class SetTrainingScheduleUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly schedule: TrainingScheduleRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
  ) {}

  async execute(command: SetTrainingScheduleCommand): Promise<TrainingScheduleEntry> {
    const player = await this.players.findById(command.playerId);
    if (!player) {
      throw new Error(`Player ${command.playerId} not found`);
    }
    if (player.isRetired()) {
      throw new Error(`Cannot schedule training for retired player ${command.playerId}`);
    }

    const world = await this.worlds.findById(this.worldId);
    if (!world) {
      throw new Error(`Game world ${this.worldId} not found`);
    }

    const effectiveFrom = command.effectiveFrom ?? world.currentWeek;
    if (compareGameWeek(effectiveFrom, world.currentWeek) < 0) {
      throw new Error(
        `Cannot schedule a training focus for a past week (${JSON.stringify(effectiveFrom)}) — the world's current week is ${JSON.stringify(world.currentWeek)}`,
      );
    }

    const entry: TrainingScheduleEntry = { playerId: command.playerId, effectiveFrom, focus: command.focus };
    await this.schedule.save(entry);
    return entry;
  }
}
