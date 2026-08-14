import { PlayerId, TournamentId, isAgeEligibleForTournamentBand, isJuniorTier } from '@tennis-manager/domain';
import { ManagerId } from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository } from '../ports/ports';

export interface RegisterDoublesEntrantCommand {
  tournamentId: TournamentId;
  playerId: PlayerId;
  managerId: ManagerId;
}

/**
 * Registers a single player into a tournament's doubles field (P7b) —
 * the per-player "enter doubles" action. There is NO pair required
 * here: a manager enters one of their own players, and that player is
 * paired up at draw-formation time (FormDoublesDrawUseCase), either
 * with their persistent partner if both entered, a random other entrant,
 * or a free-agent filler. This is the same "load, delegate to the
 * aggregate, persist" shape as RegisterEntrantUseCase.
 *
 * **Junior doubles (P8)**: for a junior-tier tournament the SAME
 * one-directional age-eligibility rule singles already enforces applies
 * here (play up allowed, play down / senior-into-junior not) — so a
 * senior player can't enter a u14 doubles draw, exactly as they can't
 * enter the u14 singles draw.
 */
export class RegisterDoublesEntrantUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
  ) {}

  async execute(command: RegisterDoublesEntrantCommand): Promise<void> {
    const tournament = await this.tournaments.findById(command.tournamentId);
    if (!tournament) {
      throw new Error(`Tournament ${command.tournamentId} not found`);
    }
    const player = await this.players.findById(command.playerId);
    if (!player) {
      throw new Error(`Player ${command.playerId} not found`);
    }
    if (player.managerId !== command.managerId) {
      throw new Error(`Player ${command.playerId} is not on manager ${command.managerId}'s roster`);
    }

    if (isJuniorTier(tournament.tier) && !isAgeEligibleForTournamentBand(player.ageInWeeks, tournament.ageBand)) {
      throw new Error(
        `Player ${command.playerId} (age ${(player.ageInWeeks / 52).toFixed(1)}) is not age-eligible for the ` +
          `${tournament.ageBand} doubles draw`,
      );
    }

    // The aggregate enforces "holds a doubles draw", "not started", and
    // "not already entered".
    tournament.registerDoublesEntrant(command.playerId);

    await this.tournaments.save(tournament);
  }
}
