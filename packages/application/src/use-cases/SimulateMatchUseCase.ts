import { TournamentId, PlayerId, MatchId, Player, TournamentTier, AgeBand, GameWeek, WorldId } from '@tennis-manager/domain';
import { DrawPhase, qualifyingPointsFor, qualifyingPrizeMoneyFor, StandardPrizeMoneyTable } from '@tennis-manager/domain';
import { MatchLog } from '@tennis-manager/domain';
import { MatchSimulator } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { RankingPointsTable } from '@tennis-manager/domain';
import { RankingLedgerEntry } from '@tennis-manager/domain';
import { ManagerXpPolicy } from '@tennis-manager/domain';
import { ManagerLadderPolicy } from '@tennis-manager/domain';
import { PlayerDevelopmentPolicy } from '@tennis-manager/domain';
import { applyGraduationCarryover, RankingBand } from '@tennis-manager/domain';
import { RankingCalculationService, bestResultsCapFor, matchesRankingBand } from '@tennis-manager/domain';
import { isNewPeak, PeakRankingEntry, TitleRecord } from '@tennis-manager/domain';
import { fatigueCostForMatch } from '@tennis-manager/domain';
import { scaleMatchLogToReveal } from './matchSchedule';
import {
  EventPublisherPort,
  GameWorldRepository,
  PeakRankingRepository,
  RankingLedgerRepository,
  ManagerXpRepository,
  ManagerLadderRepository,
  MatchLogStorePort,
  PlayerRepository,
  TitleRepository,
  TournamentRepository,
} from '../ports/ports';

/** PLACEHOLDER, not tuned — same illustrative-constant discipline as
 * every other Standard* policy/flagged magic number in this codebase
 * (StandardTrainingPolicy's BASE_GAIN, composition.ts's
 * PRO_DECLINE_MULTIPLIER). Automatic surface-affinity growth from
 * simply having played a match on this surface — see
 * Player.applyMatchSurfaceGrowth's doc comment for why this exists at
 * all (a real regression this constant/wiring fixes: surface affinity
 * had no growth path except a manager explicitly choosing that exact
 * weekly TrainingFocus).
 *
 * **1, not something smaller — a real constraint, not an arbitrary
 * choice.** `SurfaceAffinities.trainedOn` rounds its result to a whole
 * number (the `affinity_*` DB columns are `integer` — see that
 * method's doc comment for the bug this rounding fix closed). Every
 * call starts from an already-whole-number value, so any gain below
 * 0.5 rounds back down to exactly where it started, EVERY time,
 * forever — a "smaller than 1" automatic gain would silently never do
 * anything at all, which would just reintroduce a frozen-affinity bug
 * in a different shape. 1 is the smallest value that reliably has any
 * effect. It's still smaller than most manual weekly focus deltas
 * (StandardTrainingPolicy: base * 2, i.e. 0.6-2.0 depending on stage,
 * which themselves round to a flat +1 or +2 per week for the same
 * reason) when weighed per event, but note a player can play several
 * matches in one calendar week during an active tournament run — true
 * gradual sub-1-per-event growth isn't achievable without persisting a
 * fractional remainder somewhere, which is real added complexity, out
 * of scope for closing this regression. */
export const MATCH_SURFACE_AFFINITY_GAIN = 1;

/** Plain module-level instance, same "not constructor-injected" choice
 * as qualifyingPointsFor/scaleDoublesPoints — prize money has no
 * swappable-policy use case today (unlike RankingPointsTable, which
 * IS constructor-injected here for testability/override), so adding it
 * as a 15th constructor parameter would only churn every existing
 * call site for no real benefit. */
const PRIZE_MONEY_TABLE = new StandardPrizeMoneyTable();

export interface SimulateMatchCommand {
  matchId: MatchId;
  tournamentId: TournamentId;
  roundNumber: number;
  matchIndex: number;
  /** Which bracket the slot is in. Optional — absent means the MAIN
   * draw, so every pre-qualifying caller (and the manual simulate
   * route) is unchanged. `'qualifying'` matches are ordinary matches in
   * every respect that touches the player (fatigue, form, surface
   * growth, development XP); what differs is the points they pay out
   * and that no title is ever awarded from them. */
  draw?: DrawPhase;
  /** The match's SCHEDULED reveal start (ISO 8601) — the staggered-
   * schedule feature. Optional/absent (the manual simulate route and
   * every pre-feature caller) means the match airs immediately, stamped
   * `simulatedAt: now` exactly as before. */
  scheduledStartAt?: string;
  /** Real-time seconds the match's fake-live reveal should occupy; the
   * replay log is time-scaled to fit it (see matchSchedule.ts), so the
   * match "starts AND ends within the day". Absent = no scaling. */
  revealDurationSeconds?: number;
}

/** The canonical MatchId for a bracket slot. One deterministic id per
 * slot means one immutable replay blob per slot, and every caller
 * (HTTP route, worker job) colliding on the same id instead of
 * minting duplicates. */
export function matchIdForSlot(
  tournamentId: TournamentId,
  roundNumber: number,
  matchIndex: number,
  draw: DrawPhase = 'main',
): MatchId {
  // The qualifying bracket has its own round numbering, so its slots
  // need their own id space or a qualifying round 1 would collide with
  // the main draw's round 1 (same tournament, same replay blob id). The
  // main draw's ids are deliberately left byte-identical to before
  // qualifying existed — every stored replay stays reachable.
  const prefix = draw === 'qualifying' ? `${tournamentId}-q` : `${tournamentId}`;
  return MatchId(`${prefix}-r${roundNumber}-m${matchIndex}`);
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
 *
 * Ranking points are also awarded from here, since this is the one
 * place a player's tournament fate changes: the loser is eliminated
 * the instant any match is decided (award now, using how many rounds
 * they'd won before this loss), and the winner becomes champion
 * exactly when the match just decided was the final (award them too,
 * including this round). A player who wins a non-final match gets
 * nothing yet — they're still alive, not eliminated or crowned.
 *
 * Points are awarded to the PLAYER, not their manager — see
 * PlayerRanking's doc comment for why the original manager-cumulative
 * model was wrong. A player earns points regardless of whether they
 * currently have a manager (a released former champion keeps their
 * ranking; it isn't the manager's to hold).
 *
 * Each result is appended to the player's RankingLedgerRepository as a
 * dated entry rather than summed into a single running total — see
 * RankingCalculationService for why: real ATP rankings are a rolling
 * 52-week window with a best-18 cap, which is only possible to compute
 * from a ledger of dated results, not a mutable cumulative counter.
 *
 * Manager XP (Manager & Progression bounded context) is awarded from
 * the exact same two call sites as ranking points, immediately below
 * each awardRankingPoints call — same trigger, same "loser at
 * elimination, winner only at the final" shape, just a second write
 * alongside the existing one rather than new event-plumbing. Unlike
 * ranking points, XP goes to the player's current MANAGER (via
 * managerId), not the player themselves: XP is a manager-progression
 * currency, not a player accolade, and a player with no current
 * manager (released/free agent) simply earns no XP for anyone — there's
 * no one to credit.
 *
 * Two more permanent records get written from the exact same two
 * awardRankingPoints call sites (docs/data-archival-principles.md):
 * a per-(player, band) peak-ranking high-water-mark, refreshed every
 * time — see updatePeakIfExceeded — and, only on the winner's final-
 * round call, exactly one title/trophy row (`titles`' own schema doc
 * comment explains why that's structurally guaranteed, not just
 * usually true).
 */
export class SimulateMatchUseCase {
  constructor(
    private readonly tournaments: TournamentRepository,
    private readonly players: PlayerRepository,
    private readonly matchSimulator: MatchSimulator,
    private readonly matchLogs: MatchLogStorePort,
    private readonly events: EventPublisherPort,
    private readonly bracketGenerator: BracketGenerator,
    private readonly rankingPointsTable: RankingPointsTable,
    private readonly rankingLedger: RankingLedgerRepository,
    private readonly managerXpPolicy: ManagerXpPolicy,
    private readonly managerXp: ManagerXpRepository,
    private readonly managerLadderPolicy: ManagerLadderPolicy,
    private readonly managerLadder: ManagerLadderRepository,
    private readonly peakRankings: PeakRankingRepository,
    private readonly titles: TitleRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
    private readonly developmentPolicy: PlayerDevelopmentPolicy,
  ) {}

  async execute(command: SimulateMatchCommand): Promise<{ replayUrl: string }> {
    const tournament = await this.tournaments.findById(command.tournamentId);
    if (!tournament) throw new Error(`Tournament ${command.tournamentId} not found`);

    // Same fallback RankPositionQuery uses (week 1 of season 1) for a
    // fresh dev DB whose world clock hasn't ticked yet — the rolling-
    // window peak computation below needs SOME "now" to filter
    // against, and this keeps that consistent with how every other
    // ranking read in this codebase already defines "now".
    const world = await this.worlds.findById(this.worldId);
    const currentWeek: GameWeek = world?.currentWeek ?? { season: 1, week: 1 };

    const draw: DrawPhase = command.draw ?? 'main';
    const scheduledMatch = tournament.getScheduledMatch(command.roundNumber, command.matchIndex, draw);

    const [playerA, playerB] = await Promise.all([
      this.loadParticipant(scheduledMatch.entrantA, tournament.hostCountry),
      this.loadParticipant(scheduledMatch.entrantB, tournament.hostCountry),
    ]);

    const { outcome, log } = this.matchSimulator.simulate(playerA, playerB, tournament.surface);

    tournament.recordMatchOutcome(command.roundNumber, command.matchIndex, outcome, draw);

    if (tournament.isRoundComplete(command.roundNumber, draw) && !tournament.isFinalRound(command.roundNumber, draw)) {
      // Each bracket advances within itself, using its own field and its
      // own size. A qualifying draw stops at its LAST qualifying round
      // (isFinalRound(..., 'qualifying')) rather than playing down to one
      // winner — its survivors are promoted into the main draw instead,
      // by PromoteQualifiersUseCase.
      const rounds = draw === 'qualifying' ? tournament.getQualifyingRounds() : tournament.getRounds();
      const completedRound = rounds[command.roundNumber - 1];
      const nextRound = this.bracketGenerator.generateNextRound(
        completedRound,
        draw === 'qualifying' ? tournament.qualifyingEntrants : tournament.mainEntrants,
        draw === 'qualifying' ? tournament.qualifyingDrawSize : tournament.drawSize,
      );
      tournament.addRound(nextRound, draw);
    }
    // If it was the final round instead, there's nothing further to
    // generate — the TournamentCompleted event Tournament already
    // emitted above is the signal for that.

    // Record the scheduled reveal start + window on the aggregate so the
    // single save below persists them (the bracket DTO reads them back for
    // the countdown). Set BEFORE save so they round-trip alongside the
    // outcome, never as a second write.
    if (command.scheduledStartAt) {
      tournament.setMatchSchedule(
        command.roundNumber,
        command.matchIndex,
        command.scheduledStartAt,
        command.revealDurationSeconds ?? 0,
        draw,
      );
    }

    await this.tournaments.save(tournament);
    await this.events.publish(tournament.pullDomainEvents());

    // Stamped here, not by the simulator (which stays pure/deterministic
    // given a RandomSource) — this is the real moment the "wall-clock-
    // synced Premiere" playback model (docs/ui-direction.md) anchors to.
    // With the staggered-schedule feature this is the match's SCHEDULED
    // reveal start (a future wall-clock time the bracket counts down to),
    // not the instant of simulation; absent that, it stays `now` exactly
    // as before.
    const simulatedAt = command.scheduledStartAt ?? new Date().toISOString();
    const timestampedLog: MatchLog = {
      ...(command.revealDurationSeconds ? scaleMatchLogToReveal(log, command.revealDurationSeconds) : log),
      simulatedAt,
    };
    const { url } = await this.matchLogs.save(command.matchId, timestampedLog);

    // Apply resulting fatigue AND automatic surface-affinity growth to
    // both players, for the surface actually played, and persist. See
    // MATCH_SURFACE_AFFINITY_GAIN's doc comment for why the latter is
    // here at all. Fatigue accrual is stamina-modulated (higher stamina
    // tires less — see fatigueCostForMatch); form accrues a flat +1 per
    // real match (both players), the accrual half of the rhythm system
    // that AdvanceWorldWeekUseCase decays weekly.
    const winnerPlayer = await this.players.findById(outcome.winner);
    const loserPlayer = await this.players.findById(outcome.loser);
    // Player-development XP (docs/rocking-rackets-competitive-analysis.md
    // §1c): both participants learn from the match, scaled by how
    // competitive it was — the MATCH loser's total games won across all
    // sets. A 6-0 6-0 blowout teaches almost nothing; a 7-6 7-6 war
    // teaches a lot. The winner earns a fixed fraction of the loser's
    // share (see PlayerDevelopmentPolicy.matchExperience). setScores are
    // recorded relative to the match winner/loser, so summing loserGames
    // across sets is the loser's whole-match games total directly. This
    // XP is what applyTraining later spends — every player develops by
    // playing, free agents and fillOnly players included (they have no
    // manager to earn manager XP for, but still grow their own game).
    const loserGames = outcome.setScores.reduce((sum, set) => sum + set.loserGames, 0);
    if (winnerPlayer) {
      winnerPlayer.applyMatchFatigue(fatigueCostForMatch(winnerPlayer.attributes.physical.stamina.value));
      winnerPlayer.applyMatchForm(1);
      winnerPlayer.applyMatchSurfaceGrowth(tournament.surface, MATCH_SURFACE_AFFINITY_GAIN);
      winnerPlayer.gainExperience(this.developmentPolicy.matchExperience({ loserGames, isWinner: true }));
    }
    if (loserPlayer) {
      loserPlayer.applyMatchFatigue(fatigueCostForMatch(loserPlayer.attributes.physical.stamina.value));
      loserPlayer.applyMatchForm(1);
      loserPlayer.applyMatchSurfaceGrowth(tournament.surface, MATCH_SURFACE_AFFINITY_GAIN);
      loserPlayer.gainExperience(this.developmentPolicy.matchExperience({ loserGames, isWinner: false }));
    }
    if (winnerPlayer) await this.players.save(winnerPlayer);
    if (loserPlayer) await this.players.save(loserPlayer);

    // Ranking points: the loser is eliminated the moment any match is
    // decided; the winner becomes champion only if this was the final.
    // A qualifying loss pays QUALIFYING points (small, explicitly
    // placeholder — see qualifyingPointsFor), not main-draw points: this
    // player never reached the main draw. A player who comes THROUGH
    // qualifying is never awarded here at all (they weren't eliminated),
    // so each player still ends a tournament with at most ONE ranking-
    // ledger entry, whichever draw they went out in.
    await this.awardRankingPoints(
      loserPlayer,
      tournament.roundsWonBy(outcome.loser, draw),
      tournament.tier,
      tournament.ageBand,
      tournament.id,
      tournament.weekScheduled,
      currentWeek,
      draw,
    );
    await this.awardManagerXp(loserPlayer, 'loss', tournament.tier);
    // Only the MAIN draw's final crowns a champion. A completed
    // qualifying draw awards nothing extra and no title — its winners'
    // reward is the main-draw place PromoteQualifiersUseCase gives them.
    if (draw === 'main' && tournament.isFinalRound(command.roundNumber)) {
      await this.awardRankingPoints(
        winnerPlayer,
        tournament.roundsWonBy(outcome.winner),
        tournament.tier,
        tournament.ageBand,
        tournament.id,
        tournament.weekScheduled,
        currentWeek,
      );
      await this.awardManagerXp(winnerPlayer, 'win', tournament.tier);

      // Exactly one title row, for the actual winner, right at the
      // moment their final-round win is recorded — never for the
      // loser, never for a non-final round. A started tournament is
      // guaranteed to reach a real final match (Tournament.
      // startWithBracket refuses a draw too sparse to ever produce
      // one), so there is always a genuine winner here to credit.
      if (winnerPlayer) {
        const title: TitleRecord = {
          tournamentId: tournament.id,
          playerId: winnerPlayer.id,
          tier: tournament.tier,
          ageBand: tournament.ageBand,
          weekEarned: tournament.weekScheduled,
        };
        await this.titles.append(title);
      }
    }

    return { replayUrl: url };
  }

  private async awardRankingPoints(
    player: Player | null,
    roundsWon: number,
    tier: TournamentTier,
    ageBand: AgeBand | null,
    tournamentId: TournamentId,
    weekEarned: GameWeek,
    currentWeek: GameWeek,
    draw: DrawPhase = 'main',
  ): Promise<void> {
    if (!player) return;
    const rawPoints =
      draw === 'qualifying' ? qualifyingPointsFor(tier, roundsWon) : this.rankingPointsTable.pointsFor(tier, roundsWon);

    // A dormant graduation-carryover bonus (see
    // domain/ranking/GraduationCarryover.ts) only ever amplifies a
    // real result — it never fires on a 0-point entry (a first-round
    // exit isn't "actually winning" in the new band), and only once:
    // applyGraduationCarryover tells us whether this was the
    // qualifying moment, so we clear it on the player right here
    // rather than leaving it to fire again on a later result.
    const entryBand: RankingBand = ageBand ?? 'senior';
    const { points, consumed } = applyGraduationCarryover(rawPoints, entryBand, player.dormantCarryoverBonus);

    // Prize money (see StandardPrizeMoneyTable's doc comment): unlike
    // ranking points, real ATP rule 3.08.B.3 pays for any match played
    // — a first-round loss is NOT zeroed out the way points are, so
    // this is computed independently rather than derived from `points`.
    const prizeMoney =
      draw === 'qualifying' ? qualifyingPrizeMoneyFor(tier, roundsWon) : PRIZE_MONEY_TABLE.prizeMoneyFor(tier, roundsWon);

    let playerMutated = false;
    if (consumed) {
      player.setDormantCarryoverBonus(null);
      playerMutated = true;
    }
    if (prizeMoney > 0) {
      player.creditPrizeMoney(prizeMoney);
      playerMutated = true;
    }
    if (playerMutated) {
      await this.players.save(player);
    }

    const entry: RankingLedgerEntry = { playerId: player.id, tournamentId, tier, ageBand, points, weekEarned };
    await this.rankingLedger.append(entry);

    // The decaying manager ladder (the public competitive standing —
    // docs/rocking-rackets-competitive-analysis.md §1d) banks the same
    // points here, at the exact event that writes the ranking ledger,
    // for the player's manager (fillOnly/free-agent players have no
    // manager to credit). A 0-point result banks 0 (creditFor / the
    // adapter's amount<=0 guard make it a no-op) — the ladder, like the
    // ledger, only ever grows on a real, points-earning win.
    if (player.managerId) {
      await this.managerLadder.credit(player.managerId, this.managerLadderPolicy.creditFor(points));
    }

    await this.updatePeakIfExceeded(player.id, entryBand, currentWeek);
  }

  /**
   * Recomputes this player's real rolling total for the band the
   * entry just written belongs to (same RankingCalculationService any
   * other ranking read uses — never a second, approximate formula),
   * and overwrites the stored peak ONLY if it's a genuine new high
   * (see PeakRanking.isNewPeak — ties and drops never touch the
   * stored row). Reads via findByPlayer, not the whole-table
   * sortedRankings() a leaderboard needs — this only ever needs ONE
   * player's numbers, and findByPlayer is the now-indexed query for
   * exactly that (docs/data-archival-principles.md's index audit).
   */
  private async updatePeakIfExceeded(playerId: PlayerId, band: RankingBand, currentWeek: GameWeek): Promise<void> {
    const allEntries = await this.rankingLedger.findByPlayer(playerId);
    const bandEntries = allEntries.filter((e) => matchesRankingBand(e.ageBand, band));
    const calculator = new RankingCalculationService(bestResultsCapFor(band));
    const freshTotal = calculator.calculateTotal(bandEntries, currentWeek);

    const currentPeak = await this.peakRankings.findOne(playerId, band);
    if (!isNewPeak(freshTotal, currentPeak)) return;

    const updated: PeakRankingEntry = { playerId, band, peakPoints: freshTotal, peakAsOfWeek: currentWeek };
    await this.peakRankings.upsert(updated);
  }

  private async awardManagerXp(player: Player | null, result: 'win' | 'loss', tier: TournamentTier): Promise<void> {
    if (!player || !player.managerId) return;
    const xp = this.managerXpPolicy.xpFor(result, tier);
    await this.managerXp.credit(player.managerId, xp);
  }

  private async loadParticipant(playerId: PlayerId, hostCountry: string | null) {
    const player = await this.players.findById(playerId);
    if (!player) throw new Error(`Player ${playerId} not found`);
    return {
      playerId: player.id,
      attributes: player.attributes,
      fatigue: player.fatigue,
      form: player.form,
      // Home advantage (P6): a real, non-empty host country matching the
      // player's own nationality. A tournament with no recorded host
      // country (pre-P6 rows, tests) never makes anyone "home".
      homeAdvantage: hostCountry != null && hostCountry === player.nationality,
    };
  }
}
