import { PlayerId, TournamentId } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
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
 * tournament — created via OpenRegistrationUseCase, not
 * OpenTournamentUseCase, which opens a tournament AND registers a
 * fixed entrant list AND starts the bracket in one call (the right
 * shape for admin-seeded draws, but it can't express "a manager
 * clicks Enter on one player, for a tournament other managers are
 * also still registering for"). Tournament.registerEntrant() already
 * enforces every invariant that matters here (draw not full, not
 * already registered, not started).
 *
 * There's still no registration-window/deadline concept (CLAUDE.md:
 * "nothing drives one asynchronously yet"), so the simplest honest
 * rule stands in for one: the draw closes and the bracket starts the
 * moment the last slot fills, right here — not on a scheduled job,
 * since nothing else currently transitions a tournament out of "open
 * for registration."
 */
export class RegisterEntrantUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly bracketGenerator: BracketGenerator,
  ) {}

  async execute(command: RegisterEntrantCommand): Promise<void> {
    const tournament = await this.tournaments.findById(command.tournamentId);
    if (!tournament) {
      throw new Error(`Tournament ${command.tournamentId} not found`);
    }

    tournament.registerEntrant({ playerId: command.playerId, seed: command.seed ?? null });

    if (tournament.entrants.length === tournament.drawSize) {
      const bracket = this.bracketGenerator.generate(tournament.entrants, tournament.drawSize);
      tournament.startWithBracket(bracket);
    }

    await this.tournaments.save(tournament);
  }
}
