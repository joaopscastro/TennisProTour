import { DrawPhase, daysBetween, GameDay, MatchId, Tournament, TournamentSchedulePolicy, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, TournamentRepository } from '../ports/ports';
import { matchIdForSlot, SimulateMatchUseCase } from './SimulateMatchUseCase';
import { doublesMatchIdForSlot, SimulateDoublesMatchUseCase } from './SimulateDoublesMatchUseCase';
import { DEFAULT_DAY_WINDOW_SECONDS, revealWindowSecondsFor, scheduledStartAtFor } from './matchSchedule';

export interface SimulateDueMatchesCommand {
  worldId: WorldId;
  /** The real-time length of one game DAY (in seconds) — what the
   * staggered-schedule reveal window is derived from (a round's matches
   * divide it evenly). Omitted = DEFAULT_DAY_WINDOW_SECONDS (the 24h
   * production cron day). The worker passes WORLD_TICK_INTERVAL_MS/1000
   * in dev; tests omit it. */
  dayWindowSeconds?: number;
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
    // The staggered-schedule anchor: the wall-clock moment this sweep runs
    // (≈ the day tick that just advanced the world). A round's matches
    // stagger from here by the round's reveal window (see matchSchedule.ts).
    const anchorMs = Date.now();
    const dayWindowSeconds = command.dayWindowSeconds ?? DEFAULT_DAY_WINDOW_SECONDS;

    for (const tournament of await this.tournaments.findStarted()) {
      // A tournament that holds qualifying plays THAT bracket first, on
      // its opening days, and its main draw does not exist at all until
      // PromoteQualifiersUseCase seeds it (deferred main-draw seeding —
      // docs/ranking-realism-proposal.md §5). So the draw to sweep is
      // whichever one is currently live; a tournament between the two
      // (qualifying done, main draw not yet seeded) has nothing due.
      const draw: DrawPhase =
        tournament.hasQualifying && !tournament.isQualifyingComplete() ? 'qualifying' : 'main';
      const qualifyingNotYetSeeded = draw === 'qualifying' && !tournament.hasQualifyingDrawStarted;
      if ((draw === 'main' && !tournament.hasMainDraw) || qualifyingNotYetSeeded) {
        // No bracket seeded yet for the currently-live draw — fall
        // through to the doubles sweep below; a qualifying tournament's
        // doubles draw is independent and already playable. A real bug
        // this closes: `hasQualifying` (qualifyingDrawSize > 0) is a
        // static tier property, true from the moment a tournament is
        // opened, well before its qualifying bracket is actually SEEDED
        // (hasQualifyingDrawStarted) — `isQualifyingComplete()` already
        // correctly returns false in that gap, but that just routed
        // execution into the `else` branch below with an empty
        // `getQualifyingRounds()` array, crashing on
        // `rounds[rounds.length - 1].roundNumber` (undefined). Found
        // live: a fast-tick playtest run hit this on every single sweep
        // once a qualifying-tier tournament was open-but-not-yet-seeded.
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
            const revealSeconds = revealWindowSecondsFor(currentRound.matches.length, dayWindowSeconds);
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
                  scheduledStartAt: scheduledStartAtFor(matchIndex, revealSeconds, anchorMs),
                  revealDurationSeconds: revealSeconds,
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
        await this.sweepDoubles(tournament, today, anchorMs, dayWindowSeconds, result, this.simulateDoublesMatch);
      }
    }

    return result;
  }

  private async sweepDoubles(
    tournament: Tournament,
    today: GameDay,
    anchorMs: number,
    dayWindowSeconds: number,
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
    // Same gap as the singles branch above: `hasDoublesQualifying` is a
    // static tier property, true before the doubles qualifying bracket is
    // actually SEEDED (hasDoublesQualifyingDrawStarted) — without this
    // guard, getDoublesRounds('qualifying') below would be empty and crash
    // on `rounds[rounds.length - 1].roundNumber`.
    if (draw === 'qualifying' && !tournament.hasDoublesQualifyingDrawStarted) return;

    const rounds = tournament.getDoublesRounds(draw);
    const currentRound = rounds[rounds.length - 1];
    const finished =
      tournament.isDoublesFinalRound(currentRound.roundNumber, draw) &&
      tournament.isDoublesRoundComplete(currentRound.roundNumber, draw);
    if (finished) return;

    const scheduledDay = tournament.doublesRoundScheduledDay(currentRound.roundNumber, this.schedulePolicy, draw);
    if (daysBetween(scheduledDay, today) < 0) return;

    const revealSeconds = revealWindowSecondsFor(currentRound.matches.length, dayWindowSeconds);
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
          scheduledStartAt: scheduledStartAtFor(matchIndex, revealSeconds, anchorMs),
          revealDurationSeconds: revealSeconds,
        });
        result.simulated.push(matchId);
      } catch (error) {
        result.failed.push({ matchId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
