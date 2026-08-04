import { GameWeek } from '../shared/ids';
import { WEEKS_PER_SEASON } from '../world/GameWorld';
import { RankingLedgerEntry } from './RankingLedgerEntry';

const RANKING_WINDOW_WEEKS = 52;
const BEST_RESULTS_CAP = 18;

/** Converts a GameWeek to a single ever-increasing integer, so "weeks
 * between two GameWeeks" is plain subtraction instead of season/week
 * carry arithmetic. Only meaningful as a relative distance — the
 * absolute value has no calendar meaning. */
function absoluteWeekIndex(week: GameWeek): number {
  return week.season * WEEKS_PER_SEASON + week.week;
}

function weeksSince(earned: GameWeek, current: GameWeek): number {
  return absoluteWeekIndex(current) - absoluteWeekIndex(earned);
}

/**
 * Computes a player's current ranking total from their full ledger —
 * the real ATP mechanism (rolling 52-week window, best-18 cap,
 * mandatory/major results always counting) adapted to this game's
 * GameWeek model. Deliberately a stateless domain service rather than
 * something Player or PlayerRanking computes internally: the ledger is
 * the source of truth, the total is always derived, never stored.
 */
export class RankingCalculationService {
  calculateTotal(ledger: ReadonlyArray<RankingLedgerEntry>, currentWeek: GameWeek): number {
    const withinWindow = ledger.filter((entry) => {
      const age = weeksSince(entry.weekEarned, currentWeek);
      return age >= 0 && age <= RANKING_WINDOW_WEEKS;
    });

    const majors = withinWindow.filter((entry) => entry.tier === 'major');
    const nonMajors = withinWindow.filter((entry) => entry.tier !== 'major');

    const bestNonMajors = [...nonMajors].sort((a, b) => b.points - a.points).slice(0, BEST_RESULTS_CAP);

    const majorPoints = majors.reduce((sum, entry) => sum + entry.points, 0);
    const nonMajorPoints = bestNonMajors.reduce((sum, entry) => sum + entry.points, 0);

    return majorPoints + nonMajorPoints;
  }
}
