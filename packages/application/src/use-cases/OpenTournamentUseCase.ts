import { GameWeek, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { AgeBand, DrawSize, TournamentEntrant, TournamentTier } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';

export interface OpenTournamentCommand {
  tournamentId: TournamentId;
  tier: TournamentTier;
  surface: Surface;
  weekScheduled: GameWeek;
  drawSize: DrawSize;
  entrants: TournamentEntrant[];
  /** Required for junior tiers, forbidden for senior tiers — see
   * Tournament.open()'s validation. */
  ageBand?: AgeBand | null;
}

/**
 * Opens a tournament, registers every provided entrant, and seeds the
 * draw via BracketGenerator the moment registration closes — the
 * Competition-context sibling to HirePlayerUseCase. There's no
 * separate registration window yet (nothing drives one asynchronously
 * — see CLAUDE.md's immediate next steps), so this use case does
 * open/register/start in one call; splitting those into separate use
 * cases is a job for whenever a real registration window exists.
 */
export class OpenTournamentUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly bracketGenerator: BracketGenerator,
  ) {}

  async execute(command: OpenTournamentCommand): Promise<void> {
    const tournament = Tournament.open({
      id: command.tournamentId,
      tier: command.tier,
      surface: command.surface,
      weekScheduled: command.weekScheduled,
      drawSize: command.drawSize,
      ageBand: command.ageBand,
    });

    for (const entrant of command.entrants) {
      tournament.registerEntrant(entrant);
    }

    const bracket = this.bracketGenerator.generate(tournament.entrants, command.drawSize);
    tournament.startWithBracket(bracket);

    await this.tournaments.save(tournament);
  }
}
