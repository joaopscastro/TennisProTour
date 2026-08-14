import { DrawPhase, daysBetween, GameDay, MatchId, Tournament, TournamentSchedulePolicy, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, TournamentRepository } from '../ports/ports';
import { matchIdForSlot, SimulateMatchUseCase } from './SimulateMatchUseCase';
import { doublesMatchIdForSlot, SimulateDoublesMatchUseCase } from './SimulateDoublesMatchUseCase';

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
    /** Optional and LAST for test compatibility (the pre-P7b unit tests
     * construct this with four args); the composition root always
     * passes it. */
    private readonly simulateDoublesMatch?: SimulateDoublesMatchUseCase,
  ) {}

  async execute(command: SimulateDueMatchesCommand): Promise<SimulateDueMatchesResult> {
    const result: SimulateDueMatchesResult = { simulated: [], failed: [] };

    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const today = world.currentGameDay;

    for (const tournament of await this.tournaments.findStarted()) {
      // A tournament that holds qualifying plays THAT bracket first, on
      // its opening days, and its main draw does not exist at all until
      // PromoteQualifiersUseCase seeds it (deferred main-draw seeding —
      // docs/ranking-realism-proposal.md §5). So the draw to sweep is
      // whichever one is currently live; a tournament between the two
      // (qualifying done, main draw not yet seeded) has nothing due.
      const draw: DrawPhase =
        tournament.hasQualifying && !tournament.isQualifyingComplete() ? 'qualifying' : 'main';
      if (draw === 'main' && !tournament.hasMainDraw) {
        // No singles bracket yet — fall through to the doubles sweep
        // below; a qualifying tournament's doubles draw is independent
        // and already playable.
      } else {
        const rounds = draw === 'qualifying' ? tournament.getQualifyingRounds() : tournament.getRounds();
        const currentRound = rounds[rounds.length - 1];
        const finished =
          tournament.isFinalRound(currentRound.roundNumber, draw) &&
          tournament.isRoundComplete(currentRound.roundNumber, draw);
        if (finished) {
          // singles draw complete — still sweep doubles below
        } else {
          const scheduledDay = tournament.roundScheduledDay(currentRound.roundNumber, this.schedulePolicy, draw);
          if (daysBetween(scheduledDay, today) >= 0) {
            for (let matchIndex = 0; matchIndex < currentRound.matches.length; matchIndex++) {
              if (currentRound.matches[matchIndex].outcome !== null) continue;
              const matchId = matchIdForSlot(tournament.id, currentRound.roundNumber, matchIndex, draw);
              try {
                await this.simulateMatch.execute({
                  matchId,
                  tournamentId: tournament.id,
                  roundNumber: currentRound.roundNumber,
                  matchIndex,
                  draw,
                });
                result.simulated.push(matchId);
              } catch (error) {
                result.failed.push({ matchId, reason: error instanceof Error ? error.message : String(error) });
              }
            }
          }
        }
      }

      // The doubles draw (P7b) runs in parallel with the singles draw, on
      // the same days — sweep it independently of whichever singles draw
      // is currently live.
      if (this.simulateDoublesMatch) {
        await this.sweepDoubles(tournament, today, result, this.simulateDoublesMatch);
      }
    }

    return result;
  }

  private async sweepDoubles(
    tournament: Tournament,
    today: GameDay,
    result: SimulateDueMatchesResult,
    simulateDoublesMatch: SimulateDoublesMatchUseCase,
  ): Promise<void> {
    if (!tournament.hasDoubles) return;

    // Doubles qualifying (P8) plays FIRST, on the opening days, and the
    // main doubles draw doesn't exist until PromoteDoublesQualifiersUseCase
    // seeds it (deferred main-draw seeding). So the draw to sweep is
    // whichever is currently live.
    const draw: DrawPhase =
      tournament.hasDoublesQualifying && !tournament.isDoublesQualifyingComplete() ? 'qualifying' : 'main';
    if (draw === 'main' && !tournament.hasDoublesDrawStarted) return;

    const rounds = tournament.getDoublesRounds(draw);
    const currentRound = rounds[rounds.length - 1];
    const finished =
      tournament.isDoublesFinalRound(currentRound.roundNumber, draw) &&
      tournament.isDoublesRoundComplete(currentRound.roundNumber, draw);
    if (finished) return;

    const scheduledDay = tournament.doublesRoundScheduledDay(currentRound.roundNumber, this.schedulePolicy, draw);
    if (daysBetween(scheduledDay, today) < 0) return;

    for (let matchIndex = 0; matchIndex < currentRound.matches.length; matchIndex++) {
      if (currentRound.matches[matchIndex].outcome !== null) continue;
      const matchId = doublesMatchIdForSlot(tournament.id, currentRound.roundNumber, matchIndex, draw);
      try {
        await simulateDoublesMatch.execute({
          matchId,
          tournamentId: tournament.id,
          roundNumber: currentRound.roundNumber,
          matchIndex,
          draw,
        });
        result.simulated.push(matchId);
      } catch (error) {
        result.failed.push({ matchId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
