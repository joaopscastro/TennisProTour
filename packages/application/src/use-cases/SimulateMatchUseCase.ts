import { TournamentId, PlayerId, MatchId } from '../../../domain/src/shared/ids';
import { MatchSimulator } from '../../../domain/src/match-simulation/MatchSimulator';
import { EventPublisherPort, MatchLogStorePort, PlayerRepository, TournamentRepository } from '../ports/ports';

export interface SimulateMatchCommand {
  matchId: MatchId;
  tournamentId: TournamentId;
  roundNumber: number;
  matchIndex: number;
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
