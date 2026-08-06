import { GameWeek } from '../shared/ids';
import { weeksBetween } from '../world/GameWorld';
import { RankingLedgerEntry } from './RankingLedgerEntry';

const RANKING_WINDOW_WEEKS = 52;
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
 * Majors still occupy one of the N slots — they aren't extra slots on
 * top of the cap — they just can't be displaced out of their slot by a
 * higher-scoring non-major the way a non-major result can displace
 * another non-major. This mirrors the real rule: a mandatory event
 * always counts toward your ranking, but playing one still "uses up" a
 * counted result the way any other tournament does. In practice this
 * only ever fires for the senior tour: no junior tier is `'major'`, so
 * `majors` is always empty when this service is used for a junior
 * band — no junior-specific branching needed to get that right.
 */
export class RankingCalculationService {
  constructor(private readonly bestResultsCap: number = DEFAULT_BEST_RESULTS_CAP) {}

  calculateTotal(ledger: ReadonlyArray<RankingLedgerEntry>, currentWeek: GameWeek): number {
    const withinWindow = ledger.filter((entry) => {
      const age = weeksBetween(entry.weekEarned, currentWeek);
      return age >= 0 && age <= RANKING_WINDOW_WEEKS;
    });

    const majors = withinWindow.filter((entry) => entry.tier === 'major');
    const nonMajors = withinWindow.filter((entry) => entry.tier !== 'major');

    const remainingSlots = Math.max(0, this.bestResultsCap - majors.length);
    const bestNonMajors = [...nonMajors].sort((a, b) => b.points - a.points).slice(0, remainingSlots);

    const majorPoints = majors.reduce((sum, entry) => sum + entry.points, 0);
    const nonMajorPoints = bestNonMajors.reduce((sum, entry) => sum + entry.points, 0);

    return majorPoints + nonMajorPoints;
  }
}
