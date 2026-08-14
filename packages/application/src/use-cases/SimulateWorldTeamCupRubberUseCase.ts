import { MatchId, MatchOutcome, PairId, PlayerId, TournamentId, WorldId, WorldTeamCupTie } from '@tennis-manager/domain';
import { DoublesPairPolicy, MatchSimulator } from '@tennis-manager/domain';
import { GameWorldRepository, MatchLogStorePort, PlayerRepository, WorldTeamCupRepository } from '../ports/ports';
import { MATCH_SURFACE_AFFINITY_GAIN } from './SimulateMatchUseCase';
import { fatigueCostForMatch } from '@tennis-manager/domain';

export interface SimulateWorldTeamCupRubberCommand {
  matchId: MatchId;
  cupId: TournamentId;
  season: number;
  /** Where the tie lives: 'group' (groupIndex/tieIndex) or 'knockout'
   * (roundNumber/tieIndex). */
  phase: 'group' | 'knockout';
  groupIndex?: number;
  roundNumber?: number;
  tieIndex: number;
  rubberIndex: number;
}

/**
 * Simulates one World Team Cup RUBBER (P8c) — a singles or doubles match
 * within a country tie. Reuses the point-by-point simulator (a doubles
 * rubber is a composite pair). No individual ranking points or titles are
 * awarded (it's a team event); rubbers still apply fatigue/form/surface
 * growth to the players involved.
 */
export class SimulateWorldTeamCupRubberUseCase {
  constructor(
    private readonly cups: WorldTeamCupRepository,
    private readonly players: PlayerRepository,
    private readonly matchSimulator: MatchSimulator,
    private readonly doublesPairPolicy: DoublesPairPolicy,
    private readonly matchLogs: MatchLogStorePort,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
  ) {}

  async execute(command: SimulateWorldTeamCupRubberCommand): Promise<{ replayUrl: string }> {
    const cup = await this.cups.findBySeason(command.season);
    if (!cup) throw new Error(`No World Team Cup for season ${command.season}`);

    const tie = this.findTie(cup, command);
    const rubber = tie.rubbers[command.rubberIndex];
    if (!rubber) throw new Error(`No rubber ${command.rubberIndex} in tie ${command.tieIndex}`);
    if (rubber.outcome) throw new Error(`Rubber ${command.rubberIndex} already has an outcome`);

    let sideA: string;
    let sideB: string;
    let participantA: { playerId: string; attributes: import('@tennis-manager/domain').PlayerAttributes; fatigue: number; form: number };
    let participantB: typeof participantA;
    let playerIds: PlayerId[];

    if (rubber.kind === 'singles') {
      sideA = rubber.playerA;
      sideB = rubber.playerB;
      const a = await this.loadPlayer(rubber.playerA);
      const b = await this.loadPlayer(rubber.playerB);
      participantA = a;
      participantB = b;
      playerIds = [rubber.playerA, rubber.playerB];
    } else {
      sideA = rubber.pairA;
      sideB = rubber.pairB;
      const aPlayers = cup.doublesPlayersFor(rubber.pairA);
      const bPlayers = cup.doublesPlayersFor(rubber.pairB);
      const [a1, a2, b1, b2] = await Promise.all([
        this.loadPlayer(aPlayers[0]),
        this.loadPlayer(aPlayers[1]),
        this.loadPlayer(bPlayers[0]),
        this.loadPlayer(bPlayers[1]),
      ]);
      participantA = this.doublesPairPolicy.compositeParticipant(rubber.pairA, a1, a2);
      participantB = this.doublesPairPolicy.compositeParticipant(rubber.pairB, b1, b2);
      playerIds = [...aPlayers, ...bPlayers];
    }

    const { outcome, log } = this.matchSimulator.simulate(participantA, participantB, cup.surface);

    cup.recordRubberOutcome(tie, command.rubberIndex, {
      winner: outcome.winner as string,
      loser: outcome.loser as string,
      setScores: outcome.setScores,
    } as MatchOutcome<string>);
    await this.cups.save(cup);

    const timestampedLog = { ...log, simulatedAt: new Date().toISOString() };
    const { url } = await this.matchLogs.save(command.matchId, timestampedLog);

    for (const id of playerIds) {
      const p = await this.players.findById(id);
      if (!p) continue;
      p.applyMatchFatigue(fatigueCostForMatch(p.attributes.physical.stamina.value));
      p.applyMatchForm(1);
      p.applyMatchSurfaceGrowth(cup.surface, MATCH_SURFACE_AFFINITY_GAIN);
      await this.players.save(p);
    }

    return { replayUrl: url };
  }

  private findTie(cup: import('@tennis-manager/domain').WorldTeamCup, command: SimulateWorldTeamCupRubberCommand): WorldTeamCupTie {
    if (command.phase === 'group') {
      return cup.groups[command.groupIndex!].ties[command.tieIndex];
    }
    return cup.knockout[command.roundNumber! - 1][command.tieIndex];
  }

  private async loadPlayer(playerId: PlayerId) {
    const player = await this.players.findById(playerId);
    if (!player) throw new Error(`Player ${playerId} not found`);
    return {
      playerId,
      attributes: player.attributes,
      fatigue: player.fatigue,
      form: player.form,
    };
  }
}
