import { PlayerId, TournamentId } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';

export interface RegisterEntrantCommand {
  tournamentId: TournamentId;
  playerId: PlayerId;
  /** Unseeded by default — direct roster-row "Enter" actions don't
   * carry a seed the way an admin-configured draw might. */
  seed?: number | null;
}

/**
 * Registers a single player into an already-open (not-yet-started)
 * tournament. Distinct from OpenTournamentUseCase, which opens a
 * tournament AND registers a fixed entrant list AND starts the
 * bracket in one call — that's the right shape for admin-seeded
 * draws, but it can't express "a manager clicks Enter on one player,
 * for a tournament other managers are also still registering for."
 * Tournament.registerEntrant() already enforces every invariant that
 * matters here (draw not full, not already registered, not started),
 * so this use case is pure orchestration — load, delegate, persist —
 * same shape as every other use case in this package.
 */
export class RegisterEntrantUseCase {
  constructor(private readonly tournaments: TournamentRepository) {}

  async execute(command: RegisterEntrantCommand): Promise<void> {
    const tournament = await this.tournaments.findById(command.tournamentId);
    if (!tournament) {
      throw new Error(`Tournament ${command.tournamentId} not found`);
    }

    tournament.registerEntrant({ playerId: command.playerId, seed: command.seed ?? null });

    await this.tournaments.save(tournament);
  }
}
