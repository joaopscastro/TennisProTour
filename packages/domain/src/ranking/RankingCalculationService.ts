import { GameWeek } from '../shared/ids';
import { weeksBetween } from '../world/GameWorld';
import { isObligatoryTier } from '../competition/CompetitionTypes';
import { RankingLedgerEntry } from './RankingLedgerEntry';

/** The rolling window (in game weeks) a result counts for. Exported
 * because the obligatory-tournament rule's live wiring has to gather
 * exactly the events held inside the SAME window this calculator
 * scores (see ApplyObligatoryTournamentZerosUseCase) — deriving that
 * boundary from a second, independently-declared 52 would be a real
 * drift risk, not a stylistic one. */
export const RANKING_WINDOW_WEEKS = 52;
/** The senior tour's real ATP-derived best-N cap — the default so
 * every pre-existing senior call site (`new RankingCalculationService()`)
 * keeps working unchanged. Junior bands pass 6 explicitly instead (the
 * real ITF rule) — see `RankingBand.bestResultsCapFor`. */
const DEFAULT_BEST_RESULTS_CAP = 18;

/**
 * Computes a player's current ranking total from their full ledger —
 * the real rolling-52-week/best-N-results mechanism (mandatory/major
 * results always counting) adapted to this game's GameWeek model.
 * Deliberately a stateless domain service rather than something Player
 * or PlayerRanking computes internally: the ledger is the source of
 * truth, the total is always derived, never stored.
 *
 * `bestResultsCap` (N) is a constructor parameter, not a fixed
 * constant — the senior tour and both junior bands (U14/U16) share
 * this exact same mechanism, just with a different N (18 for the
 * senior tour, matching real ATP; 6 for either junior band, matching
 * the real ITF rule — see `RankingBand.bestResultsCapFor` and
 * docs/junior-circuit-research-and-proposal.md's "same rolling-ranking
 * shape" section). This is intentionally the ONLY axis of variation:
 * there is no separate junior calculation path, just this same class
 * reused with a smaller N and, one layer up, a ledger already filtered
 * to one band (see RankPositionQuery) — a player's U14 and U16 totals
 * never mix because they're computed from disjoint ledger slices, not
 * because the calculator itself knows anything about bands.
 *
 * Obligatory (mandatory) results still occupy one of the N slots — they
 * aren't extra slots on top of the cap — they just can't be displaced
 * out of their slot by a higher-scoring non-obligatory result the way
 * one non-obligatory result can displace another. This mirrors the real
 * rule: a mandatory event always counts toward your ranking, but it
 * still "uses up" a counted result the way any other tournament does.
 * Crucially, this is what makes a MANDATORY-SKIP zero (a `points: 0`,
 * `obligatory: true` entry for an event you were eligible for but
 * skipped — see docs/ranking-realism-proposal.md and
 * ObligatoryTournamentPolicy) actually bite: it occupies a slot while
 * contributing 0 points, pushing a real positive result out of your
 * best-N and lowering your total. "Obligatory" is asked of the tier via
 * `isObligatoryTier`, not hardcoded to `'major'`, so adding a Masters-
 * equivalent obligatory tier later needs no change here. In practice
 * this only ever fires for the senior tour: no junior tier is
 * obligatory, so the obligatory bucket is always empty for a junior
 * band — no junior-specific branching needed to get that right.
 */
export class RankingCalculationService {
  constructor(private readonly bestResultsCap: number = DEFAULT_BEST_RESULTS_CAP) {}

  calculateTotal(ledger: ReadonlyArray<RankingLedgerEntry>, currentWeek: GameWeek): number {
    const withinWindow = ledger.filter((entry) => {
      const age = weeksBetween(entry.weekEarned, currentWeek);
      return age >= 0 && age <= RANKING_WINDOW_WEEKS;
    });

    const obligatory = withinWindow.filter((entry) => isObligatoryTier(entry.tier));
    const optional = withinWindow.filter((entry) => !isObligatoryTier(entry.tier));

    // Obligatory results occupy N's slots too — they can't be displaced by a
    // higher-scoring optional result, but they are STILL capped at N. Without
    // this cap a player with more obligatory results than N (possible when a
    // major is openable weekly, or many skip-zeros accumulate) would have all
    // of them counted, exceeding the best-N total the doc promises. Among the
    // obligatory bucket, the top N by points count; a 0-point skip-zero only
    // bites when it sits inside those N slots.
    const obligatoryCounted = [...obligatory].sort((a, b) => b.points - a.points).slice(0, this.bestResultsCap);
    const remainingSlots = Math.max(0, this.bestResultsCap - obligatoryCounted.length);
    const bestOptional = [...optional].sort((a, b) => b.points - a.points).slice(0, remainingSlots);

    const obligatoryPoints = obligatoryCounted.reduce((sum, entry) => sum + entry.points, 0);
    const optionalPoints = bestOptional.reduce((sum, entry) => sum + entry.points, 0);

    return obligatoryPoints + optionalPoints;
  }
}
