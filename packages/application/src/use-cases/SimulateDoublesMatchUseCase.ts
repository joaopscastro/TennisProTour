import { GameWeek, MatchId, Player, PlayerId, TournamentId, WorldId, TournamentTier, DrawPhase } from '@tennis-manager/domain';
import { DoublesPairPolicy, MatchLog, MatchSimulator } from '@tennis-manager/domain';
import { BracketGenerator, RankingPointsTable, doublesPointsFor, doublesQualifyingPointsFor } from '@tennis-manager/domain';
import { ManagerXpPolicy, ManagerLadderPolicy, PlayerDevelopmentPolicy } from '@tennis-manager/domain';
import { fatigueCostForMatch } from '@tennis-manager/domain';
import { RankingLedgerEntry, DoublesTitleRecord, isNewDoublesPeak, RankingCalculationService, doublesBestResultsCapFor, RankingBand, AgeBand } from '@tennis-manager/domain';
import {
  DoublesPairRepository,
  DoublesPeakRankingRepository,
  DoublesTitleRepository,
  EventPublisherPort,
  GameWorldRepository,
  ManagerLadderRepository,
  ManagerXpRepository,
  MatchLogStorePort,
  PlayerRepository,
  RankingLedgerRepository,
  TournamentRepository,
} from '../ports/ports';
import { MATCH_SURFACE_AFFINITY_GAIN } from './SimulateMatchUseCase';
import { scaleMatchLogToReveal } from './matchSchedule';

/** How much chemistry a pair gains from playing a doubles match together
 * (P7c). PLACEHOLDER — flat per-match, regardless of result (showing up
 * and playing together is what builds a partnership). */
const CHEMISTRY_GAIN_PER_MATCH = 1;

export interface SimulateDoublesMatchCommand {
  matchId: MatchId;
  tournamentId: TournamentId;
  roundNumber: number;
  matchIndex: number;
  /** Which doubles bracket the slot is in. Optional — absent means the
   * MAIN doubles draw, so every pre-qualifying caller is unchanged.
   * `'qualifying'` matches pay only small qualifying points and never
   * crown a title. */
  draw?: DrawPhase;
  /** The match's SCHEDULED reveal start (ISO 8601) — the staggered-
   * schedule feature. Optional/absent means airs immediately. */
  scheduledStartAt?: string;
  /** Real-time seconds the reveal should occupy; the replay log is
   * time-scaled to fit it (see matchSchedule.ts). Absent = no scaling. */
  revealDurationSeconds?: number;
}

/** The canonical MatchId for a doubles bracket slot — its own id space
 * (a `-doubles-` segment for the main draw, `-doubles-q-` for qualifying)
 * so neither can collide with the singles/qualifying round 1 of the same
 * tournament. */
export function doublesMatchIdForSlot(tournamentId: TournamentId, roundNumber: number, matchIndex: number, draw: DrawPhase = 'main'): MatchId {
  const prefix = draw === 'qualifying' ? `${tournamentId}-doubles-q` : `${tournamentId}-doubles`;
  return MatchId(`${prefix}-r${roundNumber}-m${matchIndex}`);
}

/**
 * Simulates one doubles match (P7b) — the doubles discipline's analogue
 * of SimulateMatchUseCase. The KEY reuse is the simulator itself: each
 * two-player side is collapsed into a single composite `MatchParticipant`
 * (via DoublesPairPolicy), so the point-by-point engine runs UNCHANGED —
 * a doubles match is still "side A vs side B", just with pair ids.
 *
 * What differs from singles:
 * - the outcome's winner/loser are `PairId`s (recorded into the doubles
 *   bracket);
 * - ranking points go to BOTH players of the winning pair (and a 0 entry
 *   to both of an eliminated pair), stamped `discipline: 'doubles'` and
 *   scaled by DOUBLES_POINTS_FACTOR — never mixed into singles totals;
 * - NO title and NO peak ranking is written (doubles titles/peaks are
 *   P7c, deferred — the `titles` table is PK'd on tournament_id and can't
 *   hold both a singles and a doubles winner as-is);
 * - fatigue/form/surface-growth/development XP apply to all four players
 *   exactly as they do in singles.
 */
export class SimulateDoublesMatchUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
    private readonly matchSimulator: MatchSimulator,
    private readonly doublesPairPolicy: DoublesPairPolicy,
    private readonly matchLogs: MatchLogStorePort,
    private readonly events: EventPublisherPort,
    private readonly bracketGenerator: BracketGenerator,
    private readonly rankingPointsTable: RankingPointsTable,
    private readonly rankingLedger: RankingLedgerRepository,
    private readonly managerXpPolicy: ManagerXpPolicy,
    private readonly managerXp: ManagerXpRepository,
    private readonly managerLadderPolicy: ManagerLadderPolicy,
    private readonly managerLadder: ManagerLadderRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
    private readonly developmentPolicy: PlayerDevelopmentPolicy,
    private readonly doublesPairs: DoublesPairRepository,
    private readonly doublesTitles: DoublesTitleRepository,
    private readonly doublesPeakRankings: DoublesPeakRankingRepository,
  ) {}

  async execute(command: SimulateDoublesMatchCommand): Promise<{ replayUrl: string }> {
    const tournament = await this.tournaments.findById(command.tournamentId);
    if (!tournament) throw new Error(`Tournament ${command.tournamentId} not found`);

    const draw: DrawPhase = command.draw ?? 'main';

    const scheduled = tournament.getDoublesScheduledMatch(command.roundNumber, command.matchIndex, draw);
    const pairA = tournament.doublesPlayersFor(scheduled.entrantA);
    const pairB = tournament.doublesPlayersFor(scheduled.entrantB);
    if (!pairA || !pairB) {
      throw new Error(`Could not resolve doubles pair(s) for match ${command.matchId}`);
    }

    const [a1, a2, b1, b2] = await Promise.all([
      this.players.findById(pairA.playerA),
      this.players.findById(pairA.playerB),
      this.players.findById(pairB.playerA),
      this.players.findById(pairB.playerB),
    ]);

    const participantA = this.doublesPairPolicy.compositeParticipant(
      scheduled.entrantA,
      this.loadParticipant(a1, tournament.hostCountry),
      this.loadParticipant(a2, tournament.hostCountry),
      pairA.chemistry ?? 0,
    );
    const participantB = this.doublesPairPolicy.compositeParticipant(
      scheduled.entrantB,
      this.loadParticipant(b1, tournament.hostCountry),
      this.loadParticipant(b2, tournament.hostCountry),
      pairB.chemistry ?? 0,
    );

    const { outcome, log } = this.matchSimulator.simulate(participantA, participantB, tournament.surface);
    tournament.recordDoublesMatchOutcome(command.roundNumber, command.matchIndex, outcome, draw);

    if (tournament.isDoublesRoundComplete(command.roundNumber, draw) && !tournament.isDoublesFinalRound(command.roundNumber, draw)) {
      const completedRound = tournament.getDoublesRounds(draw)[command.roundNumber - 1];
      const pairs = draw === 'qualifying' ? tournament.doublesQualifyingPairs : tournament.doublesPairs;
      const drawSize = draw === 'qualifying' ? tournament.doublesQualifyingDrawSize : tournament.doublesDrawSize;
      const seedable = pairs.map((p) => ({ playerId: p.pairId, seed: null }));
      const nextRound = this.bracketGenerator.generateNextRound(completedRound, seedable, drawSize);
      tournament.addDoublesRound(nextRound, draw);
    }

    if (command.scheduledStartAt) {
      tournament.setDoublesMatchSchedule(
        command.roundNumber,
        command.matchIndex,
        command.scheduledStartAt,
        command.revealDurationSeconds ?? 0,
        draw,
      );
    }

    await this.tournaments.save(tournament);
    await this.events.publish(tournament.pullDomainEvents());

    const simulatedAt = command.scheduledStartAt ?? new Date().toISOString();
    const timestampedLog: MatchLog = {
      ...(command.revealDurationSeconds ? scaleMatchLogToReveal(log, command.revealDurationSeconds) : log),
      simulatedAt,
    };
    const { url } = await this.matchLogs.save(command.matchId, timestampedLog);

    // Per-player effects (fatigue, form, surface growth, development XP)
    // for all four players, same as singles.
    const [winnerA, winnerB, loserA, loserB] = await Promise.all([
      this.players.findById(pairA.playerA),
      this.players.findById(pairA.playerB),
      this.players.findById(pairB.playerA),
      this.players.findById(pairB.playerB),
    ]);
    const winnerPlayers = [winnerA, winnerB];
    const loserPlayers = [loserA, loserB];
    const loserGames = outcome.setScores.reduce((sum, set) => sum + set.loserGames, 0);

    for (const p of [...winnerPlayers, ...loserPlayers]) {
      if (!p) continue;
      p.applyMatchFatigue(fatigueCostForMatch(p.attributes.physical.stamina.value));
      p.applyMatchForm(1);
      p.applyMatchSurfaceGrowth(tournament.surface, MATCH_SURFACE_AFFINITY_GAIN);
      const isWinner = winnerPlayers.includes(p);
      p.gainExperience(this.developmentPolicy.matchExperience({ loserGames, isWinner }));
      await this.players.save(p);
    }

    const winnerRoundsWon = tournament.doublesRoundsWonBy(outcome.winner, draw);
    const loserRoundsWon = tournament.doublesRoundsWonBy(outcome.loser, draw);

    const world = await this.worlds.findById(this.worldId);
    const currentWeek: GameWeek = world?.currentWeek ?? { season: 1, week: 1 };

    // Both players of each pair get their own ledger entry (doubles
    // discipline), their manager's XP/ladder credit, and a doubles peak
    // update. Qualifying pays only tiny qualifying points.
    for (const p of winnerPlayers) {
      if (p) await this.awardDoublesResult(p, winnerRoundsWon, tournament.tier, tournament.ageBand, tournament.id, tournament.weekScheduled, 'win', currentWeek, draw);
    }
    for (const p of loserPlayers) {
      if (p) await this.awardDoublesResult(p, loserRoundsWon, tournament.tier, tournament.ageBand, tournament.id, tournament.weekScheduled, 'loss', currentWeek, draw);
    }

    // Only the MAIN draw's final crowns a doubles champion pair (P7c).
    if (draw === 'main' && tournament.isDoublesFinalRound(command.roundNumber)) {
      const champion = tournament.doublesPlayersFor(outcome.winner);
      if (champion) {
        const title: DoublesTitleRecord = {
          tournamentId: tournament.id,
          playerA: champion.playerA,
          playerB: champion.playerB,
          tier: tournament.tier,
          ageBand: tournament.ageBand,
          weekEarned: tournament.weekScheduled,
        };
        await this.doublesTitles.append(title);
      }
    }

    // Grow chemistry for any PERSISTENT partnership that took the court
    // together (P7c) — both pairs, win or lose.
    for (const formedPair of [pairA, pairB]) {
      if (!formedPair.persistentPairId) continue;
      const partnership = await this.doublesPairs.findById(formedPair.persistentPairId);
      if (!partnership) continue;
      partnership.gainChemistry(CHEMISTRY_GAIN_PER_MATCH);
      await this.doublesPairs.save(partnership);
    }

    return { replayUrl: url };
  }

  private async awardDoublesResult(
    player: Player,
    roundsWon: number,
    tier: TournamentTier,
    ageBand: AgeBand | null,
    tournamentId: TournamentId,
    weekEarned: GameWeek,
    result: 'win' | 'loss',
    currentWeek: GameWeek,
    draw: DrawPhase,
  ): Promise<void> {
    const singlesPoints = this.rankingPointsTable.pointsFor(tier, roundsWon);
    const points = draw === 'qualifying' ? doublesQualifyingPointsFor(roundsWon) : doublesPointsFor(singlesPoints);

    const entry: RankingLedgerEntry = {
      playerId: player.id,
      tournamentId,
      tier,
      ageBand,
      points,
      weekEarned,
      discipline: 'doubles',
    };
    await this.rankingLedger.append(entry);

    if (player.managerId) {
      await this.managerLadder.credit(player.managerId, this.managerLadderPolicy.creditFor(points));
      await this.managerXp.credit(player.managerId, this.managerXpPolicy.xpFor(result, tier));
    }

    await this.updateDoublesPeakIfExceeded(player.id, ageBand ?? 'senior', currentWeek);
  }

  /** Recomputes this player's live DOUBLES total in the given band
   * (best-N over the `discipline: 'doubles'` ledger slice for that band,
   * via doublesBestResultsCapFor) and overwrites the stored peak only on
   * a genuine new high (isNewDoublesPeak) — the doubles analogue of
   * SimulateMatchUseCase.updatePeakIfExceeded. */
  private async updateDoublesPeakIfExceeded(playerId: PlayerId, band: RankingBand, currentWeek: GameWeek): Promise<void> {
    const entries = (await this.rankingLedger.findByPlayer(playerId)).filter(
      (e) => e.discipline === 'doubles' && (e.ageBand ?? null) === (band === 'senior' ? null : band),
    );
    const total = new RankingCalculationService(doublesBestResultsCapFor(band)).calculateTotal(entries, currentWeek);
    const peak = await this.doublesPeakRankings.findOne(playerId, band);
    if (!isNewDoublesPeak(total, peak)) return;
    await this.doublesPeakRankings.upsert({ playerId, band, peakPoints: total, peakAsOfWeek: currentWeek });
  }

  private loadParticipant(player: Player | null, hostCountry: string | null) {
    if (!player) throw new Error('A doubles participant could not be loaded');
    return {
      playerId: player.id,
      attributes: player.attributes,
      fatigue: player.fatigue,
      form: player.form,
      homeAdvantage: hostCountry != null && hostCountry === player.nationality,
    };
  }
}
