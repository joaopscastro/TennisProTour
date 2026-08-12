import { daysBetween, MatchId, TournamentSchedulePolicy, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, TournamentRepository } from '../ports/ports';
import { matchIdForSlot, SimulateMatchUseCase } from './SimulateMatchUseCase';

export interface SimulateDueMatchesCommand {
  worldId: WorldId;
}

export interface SimulateDueMatchesResult {
  simulated: MatchId[];
  failed: Array<{ matchId: MatchId; reason: string }>;
}

/**
 * The recurring "play what's due" job: find every match that's ready
 * and drive it through SimulateMatchUseCase.
 *
 * "Due" means: the tournament has started and isn't finished, the
 * match sits in the current (last generated) round with no outcome
 * yet, AND that round's scheduled day (TournamentSchedulePolicy) has
 * arrived — i.e. `roundScheduledDay <= the world's current GameDay`.
 * This is what paces a tournament at one round per day: round r is
 * simulated on its scheduled day and no sooner, then SimulateMatchUseCase
 * adds round r+1 (due on a LATER day), so a single execute() call only
 * ever advances each tournament by one round. Both entrants are known
 * by construction — a match row only ever exists with two real
 * entrants (byes never produce matches) — and the previous round is
 * complete by construction too, since Tournament.addRound() refuses to
 * add a round before the prior one finishes.
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
    private readonly worlds: GameWorldRepository,
    private readonly schedulePolicy: TournamentSchedulePolicy,
  ) {}

  async execute(command: SimulateDueMatchesCommand): Promise<SimulateDueMatchesResult> {
    const result: SimulateDueMatchesResult = { simulated: [], failed: [] };

    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const today = world.currentGameDay;

    for (const tournament of await this.tournaments.findStarted()) {
      const rounds = tournament.getRounds();
      const currentRound = rounds[rounds.length - 1];
      const finished = tournament.isFinalRound(currentRound.roundNumber) && tournament.isRoundComplete(currentRound.roundNumber);
      if (finished) continue;

      // Paced by day: only play the current round once its scheduled
      // day has arrived. daysBetween(scheduled, today) >= 0 means
      // scheduled <= today.
      const scheduledDay = tournament.roundScheduledDay(currentRound.roundNumber, this.schedulePolicy);
      if (daysBetween(scheduledDay, today) < 0) continue;

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
