import { GameWeek } from '../shared/ids';
import { weeksBetween } from '../world/GameWorld';
import { RankingLedgerEntry } from './RankingLedgerEntry';

const RANKING_WINDOW_WEEKS = 52;
const BEST_RESULTS_CAP = 18;

/**
 * Computes a player's current ranking total from their full ledger —
 * the real ATP mechanism (rolling 52-week window, best-18 cap,
 * mandatory/major results always counting) adapted to this game's
 * GameWeek model. Deliberately a stateless domain service rather than
 * something Player or PlayerRanking computes internally: the ledger is
 * the source of truth, the total is always derived, never stored.
 *
 * Majors still occupy one of the 18 slots — they aren't extra slots on
 * top of the cap — they just can't be displaced out of their slot by a
 * higher-scoring non-major the way a non-major result can displace
 * another non-major. This mirrors the real rule: a mandatory event
 * always counts toward your ranking, but playing one still "uses up" a
 * counted result the way any other tournament does.
 */
export class RankingCalculationService {
  calculateTotal(ledger: ReadonlyArray<RankingLedgerEntry>, currentWeek: GameWeek): number {
    const withinWindow = ledger.filter((entry) => {
      const age = weeksBetween(entry.weekEarned, currentWeek);
      return age >= 0 && age <= RANKING_WINDOW_WEEKS;
    });

    const majors = withinWindow.filter((entry) => entry.tier === 'major');
    const nonMajors = withinWindow.filter((entry) => entry.tier !== 'major');

    const remainingSlots = Math.max(0, BEST_RESULTS_CAP - majors.length);
    const bestNonMajors = [...nonMajors].sort((a, b) => b.points - a.points).slice(0, remainingSlots);

    const majorPoints = majors.reduce((sum, entry) => sum + entry.points, 0);
    const nonMajorPoints = bestNonMajors.reduce((sum, entry) => sum + entry.points, 0);

    return majorPoints + nonMajorPoints;
  }
}
