import { PlayerId } from '@tennis-manager/domain';
import { PlayerRepository } from '../ports/ports';

export interface ReleasePlayerCommand {
  playerId: PlayerId;
}

/**
 * Releases a player from their manager, freeing the roster slot. Same
 * "load, delegate to the aggregate, persist" shape as every other use
 * case here — Player.releaseFromManager() already existed on the
 * domain aggregate (it's how a released player's ranking survives:
 * SimulateMatchUseCase awards points to the player regardless of
 * managerId), it just had no application-layer entry point calling it
 * yet.
 *
 * Deliberately a standalone use case, not a roster-row quick action:
 * per the roster spec, release/cut is a less frequent, more
 * consequential decision than entering a tournament or changing
 * training focus, so it should require drilling in rather than being
 * a one-click button on the row.
 */
export class ReleasePlayerUseCase {
  constructor(private readonly players: PlayerRepository) {}

  async execute(command: ReleasePlayerCommand): Promise<void> {
    const player = await this.players.findById(command.playerId);
    if (!player) {
      throw new Error(`Player ${command.playerId} not found`);
    }

    player.releaseFromManager();

    await this.players.save(player);
  }
}
