import { PlayerId } from '@tennis-manager/domain';
import { TrainingFocus, TrainingPolicy } from '@tennis-manager/domain';
import { PlayerRepository } from '../ports/ports';

export interface TrainPlayerCommand {
  playerId: PlayerId;
  focus: TrainingFocus;
}

/**
 * Use case = application service, same shape as HirePlayerUseCase:
 * load the aggregate, delegate to its domain logic, persist. The
 * TrainingPolicy is a plain domain object (no I/O, like
 * BracketGenerator or RankingPointsTable elsewhere), so it's injected
 * directly here rather than behind a port.
 */
export class TrainPlayerUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly trainingPolicy: TrainingPolicy,
  ) {}

  async execute(command: TrainPlayerCommand): Promise<void> {
    const player = await this.players.findById(command.playerId);
    if (!player) {
      throw new Error(`Player ${command.playerId} not found`);
    }

    player.applyTraining(command.focus, this.trainingPolicy);

    await this.players.save(player);
  }
}
