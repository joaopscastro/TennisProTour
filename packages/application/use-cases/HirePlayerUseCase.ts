import { ManagerId } from '../../domain/shared/ids';
import { Player } from '../../domain/player/Player';
import { PlayerRepository } from '../ports/ports';

export interface HirePlayerCommand {
  managerId: ManagerId;
  player: Player;
}

/**
 * Enforces the roster-size cap central to the "scarcity by design"
 * game-design principle (see business plan, section 1–2). `maxRosterSizeFor`
 * is a deliberate seam for the not-yet-built Manager & Progression /
 * Billing contexts: once subscription entitlements exist, this becomes
 * a lookup through those ports instead of a hardcoded constant, without
 * this use case's caller needing to change at all (Open/Closed).
 */
export class HirePlayerUseCase {
  private static readonly DEFAULT_ROSTER_CAP = 3;

  constructor(private readonly players: PlayerRepository) {}

  async execute(command: HirePlayerCommand): Promise<void> {
    const currentRoster = await this.players.findByManager(command.managerId);
    const maxRosterSize = this.maxRosterSizeFor(command.managerId);

    if (currentRoster.length >= maxRosterSize) {
      throw new Error(
        `Manager ${command.managerId} already has ${currentRoster.length} players, at the roster cap of ${maxRosterSize}`,
      );
    }

    await this.players.save(command.player);
  }

  /**
   * Placeholder until Manager & Progression / Billing exist: every
   * manager gets the free-tier cap. A real entitlement lookup will
   * replace this body without touching `execute`.
   */
  private maxRosterSizeFor(_managerId: ManagerId): number {
    return HirePlayerUseCase.DEFAULT_ROSTER_CAP;
  }
}
