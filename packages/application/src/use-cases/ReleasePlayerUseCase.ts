import { PlayerId } from '@tennis-manager/domain';
import { DoublesPairRepository, PlayerRepository } from '../ports/ports';

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
 *
 * **Doubles cascade (P7a)**: releasing a player turns them into a free
 * agent, and a free agent can't be in a pair — so any active or pending
 * pair involving the released player is dissolved here, in the same
 * pass. This is the one cross-aggregate consequence of release, and it
 * must happen eagerly rather than be discovered later by a dangling
 * "active pair whose partner no longer has a manager" row.
 */
export class ReleasePlayerUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly pairs: DoublesPairRepository,
  ) {}

  async execute(command: ReleasePlayerCommand): Promise<void> {
    const player = await this.players.findById(command.playerId);
    if (!player) {
      throw new Error(`Player ${command.playerId} not found`);
    }

    player.releaseFromManager();

    await this.players.save(player);

    // Dissolve any pair the released player was part of — it can no
    // longer stand. dissolve() is idempotent, so this is safe even if
    // a pair was already ended.
    const involving = await this.pairs.findByPlayer(command.playerId);
    for (const pair of involving) {
      pair.dissolve();
      await this.pairs.save(pair);
    }
  }
}
