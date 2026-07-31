import { TournamentId, PlayerId, MatchId } from '@tennis-manager/domain';
import { MatchSimulator } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { EventPublisherPort, MatchLogStorePort, PlayerRepository, TournamentRepository } from '../ports/ports';

export interface SimulateMatchCommand {
  matchId: MatchId;
  tournamentId: TournamentId;
  roundNumber: number;
  matchIndex: number;
}

/** The canonical MatchId for a bracket slot. One deterministic id per
 * slot means one immutable replay blob per slot, and every caller
 * (HTTP route, worker job) colliding on the same id instead of
 * minting duplicates. */
export function matchIdForSlot(tournamentId: TournamentId, roundNumber: number, matchIndex: number): MatchId {
  return MatchId(`${tournamentId}-r${roundNumber}-m${matchIndex}`);
}

/**
 * This use case is the cross-context orchestration point: it reads
 * from Player & Roster (attributes, fatigue), calls into Match
 * Simulation (a pure domain service via its port), then writes back
 * into Competition (recording the outcome on the Tournament
 * aggregate). None of the three contexts talk to each other directly
 * — the application layer is the only place that knows about all
 * three, which is exactly what keeps each bounded context
 * independently testable and, later, independently deployable.
 *
 * Note the timing model: this runs once, synchronously, whenever the
 * match is due (triggered by a scheduled job, not a live client
 * request). There is no "live" push to any client here at all — the
 * MatchLog produced by the simulator is written once via
 * MatchLogStorePort, and every viewer later fetches that same
 * immutable blob and fakes the live experience client-side. Viewer
 * count therefore has zero effect on this use case or its cost.
 */
export class SimulateMatchUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
    private readonly matchSimulator: MatchSimulator,
    private readonly matchLogs: MatchLogStorePort,
    private readonly events: EventPublisherPort,
    private readonly bracketGenerator: BracketGenerator,
  ) {}

  async execute(command: SimulateMatchCommand): Promise<{ replayUrl: string }> {
    const tournament = await this.tournaments.findById(command.tournamentId);
    if (!tournament) throw new Error(`Tournament ${command.tournamentId} not found`);

    const scheduledMatch = tournament.getScheduledMatch(command.roundNumber, command.matchIndex);

    const [playerA, playerB] = await Promise.all([
      this.loadParticipant(scheduledMatch.entrantA),
      this.loadParticipant(scheduledMatch.entrantB),
    ]);

    const { outcome, log } = this.matchSimulator.simulate(playerA, playerB, tournament.surface);

    tournament.recordMatchOutcome(command.roundNumber, command.matchIndex, outcome);

    if (tournament.isRoundComplete(command.roundNumber) && !tournament.isFinalRound(command.roundNumber)) {
      const completedRound = tournament.getRounds()[command.roundNumber - 1];
      const nextRound = this.bracketGenerator.generateNextRound(
        completedRound,
        tournament.entrants,
        tournament.drawSize,
      );
      tournament.addRound(nextRound);
    }
    // If it was the final round instead, there's nothing further to
    // generate — the TournamentCompleted event Tournament already
    // emitted above is the signal for that.

    await this.tournaments.save(tournament);
    await this.events.publish(tournament.pullDomainEvents());

    const { url } = await this.matchLogs.save(command.matchId, log);

    // Apply resulting fatigue to both players and persist.
    const winnerPlayer = await this.players.findById(outcome.winner);
    const loserPlayer = await this.players.findById(outcome.loser);
    winnerPlayer?.applyMatchFatigue(8);
    loserPlayer?.applyMatchFatigue(8);
    if (winnerPlayer) await this.players.save(winnerPlayer);
    if (loserPlayer) await this.players.save(loserPlayer);

    return { replayUrl: url };
  }

  private async loadParticipant(playerId: PlayerId) {
    const player = await this.players.findById(playerId);
    if (!player) throw new Error(`Player ${playerId} not found`);
    return {
      playerId: player.id,
      attributes: player.attributes,
      fatigue: player.fatigue,
    };
  }
}
