import { MatchId, Player, PlayerId, TournamentId, WorldId, TournamentTier, PairId } from '@tennis-manager/domain';
import { DoublesPairPolicy, MatchLog, MatchSimulator, MatchParticipant, DoublesTitleRecord, TitleRecord, RankingLedgerEntry, scaleDoublesPoints, RankingCalculationService, doublesBestResultsCapFor, isNewDoublesPeak, isNewPeak, RankingBand, PeakRankingEntry } from '@tennis-manager/domain';
import { fatigueCostForMatch } from '@tennis-manager/domain';
import {
  DoublesPairRepository,
  DoublesPeakRankingRepository,
  DoublesTitleRepository,
  EventPublisherPort,
  GameWorldRepository,
  ManagerLadderRepository,
  ManagerXpRepository,
  MatchLogStorePort,
  MastersCupRepository,
  PeakRankingRepository,
  PlayerRepository,
  RankingLedgerRepository,
  TitleRepository,
} from '../ports/ports';
import { MATCH_SURFACE_AFFINITY_GAIN } from './SimulateMatchUseCase';

/** Capstone points for the Masters Cup (P8b) — placeholders, higher than a
 * normal tour event but below a major (the cup is the season's crown). */
const MASTERS_CUP_CHAMPION_POINTS = 1500;
const MASTERS_CUP_RUNNER_UP_POINTS = 900;
const MASTERS_CUP_SEMIFINALIST_POINTS = 450;

/** Capstone prize money for the Masters Cup — the money counterpart to
 * the points above, same PLACEHOLDER-dollar-figure caveat as
 * StandardPrizeMoneyTable. Sits between a `tour`-tier event's champion
 * payout and a `major`'s, matching where the points sit. Group-stage
 * (round-robin) matches pay no points and no money — same rule, a
 * round-robin match is a qualifier, not an eliminating result. */
const MASTERS_CUP_CHAMPION_MONEY = 400000;
const MASTERS_CUP_RUNNER_UP_MONEY = 200000;
const MASTERS_CUP_SEMIFINALIST_MONEY = 100000;

export interface SimulateMastersCupMatchCommand {
  matchId: MatchId;
  cupId: TournamentId;
  season: number;
  discipline: 'singles' | 'doubles';
  phase: 'group' | 'knockout';
  groupIndex?: number;
  roundNumber?: number;
  matchIndex: number;
}

/**
 * Simulates one Masters Cup match (P8b) — either discipline, either phase.
 * Reuses the SAME point-by-point simulator (a doubles side collapses into
 * a composite participant via DoublesPairPolicy). Group-stage matches
 * award NO ranking points (a round-robin match is a qualifier); the
 * knockout awards capstone points to the loser of each round (semifinalist
 * / runner-up) and, at the final, to the champion (plus a singles/doubles
 * title).
 */
export class SimulateMastersCupMatchUseCase {
  constructor(
    private readonly cups: MastersCupRepository,
    private readonly players: PlayerRepository,
    private readonly matchSimulator: MatchSimulator,
    private readonly doublesPairPolicy: DoublesPairPolicy,
    private readonly matchLogs: MatchLogStorePort,
    private readonly events: EventPublisherPort,
    private readonly rankingLedger: RankingLedgerRepository,
    private readonly managerXpPolicy: { xpFor(result: 'win' | 'loss', tier: TournamentTier): number },
    private readonly managerXp: ManagerXpRepository,
    private readonly managerLadder: ManagerLadderRepository,
    private readonly titles: TitleRepository,
    private readonly doublesTitles: DoublesTitleRepository,
    private readonly peakRankings: PeakRankingRepository,
    private readonly doublesPeakRankings: DoublesPeakRankingRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
  ) {}

  async execute(command: SimulateMastersCupMatchCommand): Promise<{ replayUrl: string }> {
    const cup = await this.cups.findBySeason(command.season);
    if (!cup) throw new Error(`No Masters Cup for season ${command.season}`);

    let participantA: MatchParticipant<string>;
    let participantB: MatchParticipant<string>;
    let sideA: string;
    let sideB: string;
    let playerIdsA: PlayerId[];
    let playerIdsB: PlayerId[];

    if (command.discipline === 'singles') {
      const s = command.phase === 'group'
        ? cup.getSinglesGroupScheduledMatch(command.groupIndex!, command.matchIndex)
        : cup.getSinglesKnockoutScheduledMatch(command.roundNumber!, command.matchIndex);
      sideA = s.entrantA;
      sideB = s.entrantB;
      const a = await this.loadPlayer(sideA as PlayerId, cup.surface);
      const b = await this.loadPlayer(sideB as PlayerId, cup.surface);
      participantA = a.participant;
      participantB = b.participant;
      playerIdsA = [sideA as PlayerId];
      playerIdsB = [sideB as PlayerId];
    } else {
      const s = command.phase === 'group'
        ? cup.getDoublesGroupScheduledMatch(command.groupIndex!, command.matchIndex)
        : cup.getDoublesKnockoutScheduledMatch(command.roundNumber!, command.matchIndex);
      sideA = s.entrantA;
      sideB = s.entrantB;
      const pairA = cup.doublesEntrants.find((p) => p.pairId === sideA)!;
      const pairB = cup.doublesEntrants.find((p) => p.pairId === sideB)!;
      const [a1, a2, b1, b2] = await Promise.all([
        this.loadPlayer(pairA.playerA, cup.surface),
        this.loadPlayer(pairA.playerB, cup.surface),
        this.loadPlayer(pairB.playerA, cup.surface),
        this.loadPlayer(pairB.playerB, cup.surface),
      ]);
      participantA = this.doublesPairPolicy.compositeParticipant(sideA as PairId, a1.participant, a2.participant, pairA.chemistry ?? 0);
      participantB = this.doublesPairPolicy.compositeParticipant(sideB as PairId, b1.participant, b2.participant, pairB.chemistry ?? 0);
      playerIdsA = [pairA.playerA, pairA.playerB];
      playerIdsB = [pairB.playerA, pairB.playerB];
    }

    const { outcome, log } = this.matchSimulator.simulate(participantA, participantB, cup.surface);

    if (command.discipline === 'singles') {
      const o = { winner: outcome.winner as unknown as PlayerId, loser: outcome.loser as unknown as PlayerId, setScores: outcome.setScores };
      if (command.phase === 'group') cup.recordSinglesGroupMatchOutcome(command.groupIndex!, command.matchIndex, o);
      else cup.recordSinglesKnockoutMatchOutcome(command.roundNumber!, command.matchIndex, o);
    } else {
      const o = { winner: outcome.winner as unknown as PairId, loser: outcome.loser as unknown as PairId, setScores: outcome.setScores };
      if (command.phase === 'group') cup.recordDoublesGroupMatchOutcome(command.groupIndex!, command.matchIndex, o);
      else cup.recordDoublesKnockoutMatchOutcome(command.roundNumber!, command.matchIndex, o);
    }
    await this.cups.save(cup);

    const timestampedLog: MatchLog = { ...log, simulatedAt: new Date().toISOString() };
    const { url } = await this.matchLogs.save(command.matchId, timestampedLog);

    // Per-player effects (fatigue, form, surface growth) for all involved.
    for (const id of [...playerIdsA, ...playerIdsB]) {
      const p = await this.players.findById(id);
      if (!p) continue;
      p.applyMatchFatigue(fatigueCostForMatch(p.attributes.physical.stamina.value));
      p.applyMatchForm(1);
      p.applyMatchSurfaceGrowth(cup.surface, MATCH_SURFACE_AFFINITY_GAIN);
      await this.players.save(p);
    }

    // Ranking: only the knockout pays.
    if (command.phase === 'knockout') {
      const winnerIds = outcome.winner === sideA ? playerIdsA : playerIdsB;
      const loserIds = outcome.winner === sideA ? playerIdsB : playerIdsA;
      const loserPoints = command.roundNumber === 1 ? MASTERS_CUP_SEMIFINALIST_POINTS : MASTERS_CUP_RUNNER_UP_POINTS;
      const loserMoney = command.roundNumber === 1 ? MASTERS_CUP_SEMIFINALIST_MONEY : MASTERS_CUP_RUNNER_UP_MONEY;

      for (const id of loserIds) {
        await this.awardPoints(id, command.discipline, loserPoints, loserMoney, 'loss', cup.id, cup.weekScheduled);
      }
      if (command.roundNumber === 2) {
        for (const id of winnerIds) {
          await this.awardPoints(id, command.discipline, MASTERS_CUP_CHAMPION_POINTS, MASTERS_CUP_CHAMPION_MONEY, 'win', cup.id, cup.weekScheduled);
        }
        await this.awardTitle(command.discipline, winnerIds, cup.id, cup.weekScheduled);
      }
    }

    return { replayUrl: url };
  }

  private async awardPoints(
    playerId: PlayerId,
    discipline: 'singles' | 'doubles',
    points: number,
    money: number,
    result: 'win' | 'loss',
    cupId: TournamentId,
    weekScheduled: { season: number; week: number },
  ): Promise<void> {
    const finalPoints = discipline === 'doubles' ? scaleDoublesPoints(points) : points;
    const entry: RankingLedgerEntry = {
      playerId,
      tournamentId: cupId,
      tier: 'tour',
      ageBand: null,
      points: finalPoints,
      weekEarned: weekScheduled,
      discipline: discipline === 'doubles' ? 'doubles' : 'singles',
    };
    await this.rankingLedger.append(entry);

    const player = await this.players.findById(playerId);
    if (player) {
      player.creditPrizeMoney(money);
      await this.players.save(player);
    }
    if (player?.managerId) {
      await this.managerLadder.credit(player.managerId, finalPoints);
      await this.managerXp.credit(player.managerId, this.managerXpPolicy.xpFor(result, 'tour'));
    }

    await this.updatePeakIfExceeded(playerId, discipline, weekScheduled);
  }

  private async awardTitle(
    discipline: 'singles' | 'doubles',
    winnerIds: PlayerId[],
    cupId: TournamentId,
    weekScheduled: { season: number; week: number },
  ): Promise<void> {
    if (discipline === 'singles') {
      const title: TitleRecord = { tournamentId: cupId, playerId: winnerIds[0], tier: 'tour', ageBand: null, weekEarned: weekScheduled };
      await this.titles.append(title);
    } else {
      const title: DoublesTitleRecord = { tournamentId: cupId, playerA: winnerIds[0], playerB: winnerIds[1], tier: 'tour', ageBand: null, weekEarned: weekScheduled };
      await this.doublesTitles.append(title);
    }
  }

  private async updatePeakIfExceeded(playerId: PlayerId, discipline: 'singles' | 'doubles', weekScheduled: { season: number; week: number }): Promise<void> {
    const world = await this.worlds.findById(this.worldId);
    const currentWeek = world?.currentWeek ?? { season: 1, week: 1 };
    const band: RankingBand = 'senior';
    if (discipline === 'singles') {
      const entries = (await this.rankingLedger.findByPlayer(playerId)).filter((e) => (e.discipline ?? 'singles') === 'singles' && (e.ageBand ?? null) === null);
      const total = new RankingCalculationService(18).calculateTotal(entries, currentWeek);
      const peak = await this.peakRankings.findOne(playerId, band);
      if (!isNewPeak(total, peak)) return;
      const updated: PeakRankingEntry = { playerId, band, peakPoints: total, peakAsOfWeek: currentWeek };
      await this.peakRankings.upsert(updated);
    } else {
      const entries = (await this.rankingLedger.findByPlayer(playerId)).filter((e) => e.discipline === 'doubles' && (e.ageBand ?? null) === null);
      const total = new RankingCalculationService(doublesBestResultsCapFor(band)).calculateTotal(entries, currentWeek);
      const peak = await this.doublesPeakRankings.findOne(playerId, band);
      if (!isNewDoublesPeak(total, peak)) return;
      await this.doublesPeakRankings.upsert({ playerId, band, peakPoints: total, peakAsOfWeek: currentWeek });
    }
  }

  private async loadPlayer(playerId: PlayerId, surface: string) {
    const player = await this.players.findById(playerId);
    if (!player) throw new Error(`Player ${playerId} not found`);
    return {
      playerId,
      participant: {
        playerId,
        attributes: player.attributes,
        fatigue: player.fatigue,
        form: player.form,
      } as MatchParticipant<PlayerId>,
    };
  }
}
