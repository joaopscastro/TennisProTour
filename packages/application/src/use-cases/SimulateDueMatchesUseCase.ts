import { MatchId } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';
import { matchIdForSlot, SimulateMatchUseCase } from './SimulateMatchUseCase';

export interface SimulateDueMatchesResult {
  simulated: MatchId[];
  failed: Array<{ matchId: MatchId; reason: string }>;
}

/**
 * The recurring "play what's due" job: find every match that's ready
 * and drive it through SimulateMatchUseCase.
 *
 * "Due" means: the tournament has started and isn't finished, and the
 * match sits in the current (last generated) round with no outcome
 * yet. Both entrants are known by construction — a match row only
 * ever exists with two real entrants (byes never produce matches) —
 * and the previous round is complete by construction too, since
 * Tournament.addRound() refuses to add a round before the prior one
 * finishes. So the natural "current round, outcome still null" filter
 * IS the readiness check, enforced by the aggregate rather than
 * re-derived here.
 *
 * Idempotent by the same token: a decided match has an outcome and is
 * filtered out, and if a concurrent run decides one under us, the
 * aggregate's "already has a recorded outcome" throw plus the
 * write-once replay store turn the duplicate into a per-match failure
 * entry, never a double simulation.
 */
export class SimulateDueMatchesUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly simulateMatch: SimulateMatchUseCase,
  ) {}

  async execute(): Promise<SimulateDueMatchesResult> {
    const result: SimulateDueMatchesResult = { simulated: [], failed: [] };

    for (const tournament of await this.tournaments.findStarted()) {
      const rounds = tournament.getRounds();
      const currentRound = rounds[rounds.length - 1];
      const finished = tournament.isFinalRound(currentRound.roundNumber) && tournament.isRoundComplete(currentRound.roundNumber);
      if (finished) continue;

      for (let matchIndex = 0; matchIndex < currentRound.matches.length; matchIndex++) {
        if (currentRound.matches[matchIndex].outcome !== null) continue;

        const matchId = matchIdForSlot(tournament.id, currentRound.roundNumber, matchIndex);
        try {
          await this.simulateMatch.execute({
            matchId,
            tournamentId: tournament.id,
            roundNumber: currentRound.roundNumber,
            matchIndex,
          });
          result.simulated.push(matchId);
        } catch (error) {
          result.failed.push({ matchId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    return result;
  }
}
