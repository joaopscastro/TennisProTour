import {
  computeObligatoryZeroEntries,
  HeldObligatoryTournament,
  isEligibleForDirectAcceptance,
  isObligatoryTier,
  RANKING_WINDOW_WEEKS,
  Tournament,
  TournamentId,
  weeksBetween,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, RankingLedgerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';

export interface ApplyObligatoryTournamentZerosCommand {
  worldId: WorldId;
}

export interface ApplyObligatoryTournamentZerosResult {
  /** Obligatory events held inside the current rolling window that
   * this run considered (decided finals only). */
  heldObligatory: number;
  /** Direct-acceptance-eligible players this run examined. */
  playersConsidered: number;
  /** Mandatory-skip zeros actually appended to the ledger. 0 on a
   * re-run over unchanged data — the rule is idempotent (see below). */
  zerosWritten: number;
}

/**
 * Makes the obligatory-tournament rule LIVE — the wiring
 * docs/ranking-realism-proposal.md §4 designed and deliberately left
 * unbuilt when its pure domain core (`computeObligatoryZeroEntries`)
 * shipped. Nothing here re-decides the rule: it gathers the three
 * inputs the pure policy asks for and persists whatever it returns.
 *
 * The real rule: a player ranked inside `DIRECT_ACCEPTANCE_CUTOFF` was
 * entitled to a main-draw place at every obligatory event (our
 * Grand-Slam-equivalent `major` tier today — asked via
 * `isObligatoryTier`, never hardcoded), so skipping one records a
 * `points: 0, obligatory: true` result that still burns one of their
 * best-18 counted slots, pushing a real positive result out and
 * dragging the total down. That is what stops a #1 defending a ranking
 * on soft Challenger draws while cherry-picking away from the big
 * events — the degenerate strategy the sim permitted before this.
 *
 * **Run once per WEEKLY rollover**, from the same worker handler as
 * the other weekly systems (apps/worker/src/jobs/handlers.ts), AFTER
 * `startDueTournaments` so a tournament that concluded this rollover is
 * already on file. Deliberately a SEPARATE use case rather than another
 * branch inside `AdvanceWorldWeekUseCase`: it needs two dependencies
 * (tournaments, a rank query) that class has no other reason to hold,
 * and it is a whole-population ranking correction, not a per-player
 * aging step — same "sibling weekly use case, gated on the same
 * rollover" shape as `RefreshTalentPoolUseCase` and
 * `GenerateJuniorTournamentsUseCase`.
 *
 * **Idempotency is structural, not a written-once flag.** A zero is
 * itself a ledger entry for that (player, tournament), so the very
 * next run sees that tournament id in the player's own "played" set and
 * produces nothing further for it — exactly the property
 * `computeObligatoryZeroEntries` documents. That also means a player
 * who genuinely PLAYED an event (any result, including a 0-point
 * first-round loss, which writes a real non-obligatory row) never gets
 * a skip-zero for it, and a re-run after a crash mid-loop simply
 * finishes the remainder.
 *
 * **Which events count as held**: an obligatory-tier tournament whose
 * final has actually been decided, dated to its `weekScheduled` and
 * still inside the rolling `RANKING_WINDOW_WEEKS` window (the constant
 * the calculator itself uses, imported rather than re-declared).
 * `weekScheduled` is the documented choice of "week held" over "the
 * week the final decided" — it's already stored, and a tournament's
 * rounds never span a season boundary in a way that would make the two
 * meaningfully diverge at this cadence. A skip-zero therefore ages out
 * of the window on precisely the same schedule a real result from that
 * event would.
 *
 * **Disclosed simplification** (also flagged on
 * `DIRECT_ACCEPTANCE_CUTOFF` and in the proposal doc): eligibility uses
 * each player's CURRENT senior rank, not their rank at the instant each
 * event was held. Real tours snapshot the ranking at the entry
 * deadline. This avoids storing a per-week rank history and is close
 * enough at this game's cadence; the theoretical exploit it leaves open
 * is tanking below the cutoff, skipping a major, then climbing back.
 * Revisit only if that actually happens.
 */
export class ApplyObligatoryTournamentZerosUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly tournaments: TournamentRepository,
    private readonly rankingLedger: RankingLedgerRepository,
    /** The SENIOR rank query specifically — the rule is senior-tour
     * only (no junior tier is obligatory), so there is deliberately no
     * per-band record here the way StartDueTournamentsUseCase needs
     * one. */
    private readonly seniorRankPosition: RankPositionQuery,
  ) {}

  async execute(command: ApplyObligatoryTournamentZerosCommand): Promise<ApplyObligatoryTournamentZerosResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const currentWeek = world.currentWeek;

    const started = await this.tournaments.findStarted();
    const heldObligatory: HeldObligatoryTournament[] = started
      .filter((tournament) => isObligatoryTier(tournament.tier))
      .filter((tournament) => hasDecidedFinal(tournament))
      .filter((tournament) => {
        const age = weeksBetween(tournament.weekScheduled, currentWeek);
        return age >= 0 && age <= RANKING_WINDOW_WEEKS;
      })
      .map((tournament) => ({
        tournamentId: tournament.id,
        tier: tournament.tier,
        weekHeld: tournament.weekScheduled,
      }));

    if (heldObligatory.length === 0) {
      return { heldObligatory: 0, playersConsidered: 0, zerosWritten: 0 };
    }

    // Computed ONCE per run, not once per player (the query reads and
    // scores the whole ledger each call).
    const ranked = await this.seniorRankPosition.sortedRankings();

    let playersConsidered = 0;
    let zerosWritten = 0;
    for (const [index, entry] of ranked.entries()) {
      const rank = index + 1;
      // sortedRankings() is descending, so once one player is below the
      // cutoff every player after them is too — an unranked player
      // isn't in this list at all, and owes nothing either way.
      if (!isEligibleForDirectAcceptance(rank)) break;
      playersConsidered += 1;

      const playerEntries = await this.rankingLedger.findByPlayer(entry.playerId);
      const playedTournamentIds = new Set<TournamentId>(playerEntries.map((e) => e.tournamentId));

      const zeros = computeObligatoryZeroEntries({
        playerId: entry.playerId,
        currentSeniorRank: rank,
        heldObligatory,
        playedTournamentIds,
      });
      for (const zero of zeros) {
        await this.rankingLedger.append(zero);
        zerosWritten += 1;
      }
    }

    return { heldObligatory: heldObligatory.length, playersConsidered, zerosWritten };
  }
}

/** A tournament's final is decided exactly when its last round exists
 * and every match in it has an outcome — asked through the aggregate's
 * own public API (isFinalRound/isRoundComplete), never by reaching into
 * its rounds from outside. */
function hasDecidedFinal(tournament: Tournament): boolean {
  if (!tournament.hasStarted) return false;
  const finalRound = tournament.getRounds().find((round) => tournament.isFinalRound(round.roundNumber));
  return finalRound !== undefined && tournament.isRoundComplete(finalRound.roundNumber);
}
