import { PlayerId } from '@tennis-manager/domain';
import { TrainingFocus } from '@tennis-manager/domain';
import { PlayerRepository } from '../ports/ports';

export interface SetTrainingFocusCommand {
  playerId: PlayerId;
  /** null clears the standing focus (no training delta applies until
   * a new one is set). */
  focus: TrainingFocus | null;
}

/**
 * Records a player's standing weekly training focus. This does NOT
 * apply any attribute delta itself — that happens once per game week,
 * for every player with a focus set, inside AdvanceWorldWeekUseCase's
 * tick (the same place PlayerAgingService already ages players). This
 * use case's job is only "load, delegate to Player.setTrainingFocus,
 * persist," same shape as HirePlayerUseCase.
 *
 * Formerly TrainPlayerUseCase, which applied one training session
 * immediately on each call. That one-shot semantics didn't match the
 * game design ("a manager commits to one training focus per player
 * per week") — there was no persisted "current focus" a manager could
 * glance at, and nothing applied training automatically on the weekly
 * tick the way aging already does. Renamed/repurposed rather than kept
 * alongside a new use case, since the immediate-apply behavior wasn't
 * a thing any other caller depended on.
 */
export class SetTrainingFocusUseCase {
  constructor(private readonly players: PlayerRepository) {}

  async execute(command: SetTrainingFocusCommand): Promise<void> {
    const player = await this.players.findById(command.playerId);
    if (!player) {
      throw new Error(`Player ${command.playerId} not found`);
    }

    player.setTrainingFocus(command.focus);

    await this.players.save(player);
  }
}
