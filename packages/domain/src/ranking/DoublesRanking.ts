import { GameWeek, PlayerId } from '../shared/ids';
import { RankingBand } from './RankingBand';

/**
 * Doubles ranking (P7b + junior doubles) — the small amount of
 * ranking-specific rule that lives in the domain, kept separate from the
 * singles/junior RankingBand machinery because doubles is a DISCIPLINE
 * (a filter on the same ledger) layered ON TOP of the age bands (see
 * RankingLedgerEntry.discipline + ageBand): the senior doubles ranking,
 * the U14 doubles ranking and the U16 doubles ranking are three separate
 * ladders.
 */

/** The SENIOR doubles ranking's best-N cap — RR's real number (best 14
 * over a rolling 52 weeks), vs. 18 for the senior singles tour. */
export const DOUBLES_BEST_RESULTS_CAP = 14;

/** The best-N cap for a doubles ranking in a given band: 14 for senior
 * (RR), 6 for either junior band (the real ITF junior rule — juniors
 * count their best 6 singles AND best 6 doubles). Parameterized like
 * RankingBand.bestResultsCapFor, for the same "one cap-per-band
 * decision, not re-derived per caller" reason. */
export function doublesBestResultsCapFor(band: RankingBand): number {
  return band === 'senior' ? DOUBLES_BEST_RESULTS_CAP : 6;
}

/**
 * A player's ENTRY ranking for doubles — the real ATP/WTA combined-
 * ranking rule: their doubles ranking if they have one, otherwise their
 * singles ranking. This is what makes the first doubles draws work (no
 * one has a doubles ranking yet, so everyone falls back to singles) and
 * what lets doubles ranking take over as results accumulate. Pure; the
 * two totals are computed elsewhere (the ledger queries), this only
 * picks.
 */
export function doublesEntryRanking(doublesTotal: number, singlesTotal: number): number {
  return doublesTotal > 0 ? doublesTotal : singlesTotal;
}

/** How much a doubles result is worth relative to the same singles
 * result — RR runs doubles points LOWER than singles (a doubles major
 * champion earns less than a singles one). PLACEHOLDER, applied to the
 * shared StandardRankingPointsTable value at award time rather than
 * duplicating the whole per-round table. */
export const DOUBLES_POINTS_FACTOR = 0.5;

export function doublesPointsFor(singlesPoints: number): number {
  return Math.round(singlesPoints * DOUBLES_POINTS_FACTOR);
}

/**
 * A player's permanent high-water-mark DOUBLES ranking total in one band
 * (P7c + junior doubles) — the doubles analogue of PeakRankingEntry.
 * One row per (player, band), updated in place, never append-only.
 * `peakAsOfWeek` is display context only.
 */
export interface DoublesPeakRankingEntry {
  readonly playerId: PlayerId;
  readonly band: RankingBand;
  readonly peakPoints: number;
  readonly peakAsOfWeek: GameWeek;
}

/** The doubles-peak analogue of PeakRanking.isNewPeak: a peak only ever
 * moves up. `currentPeak === null` = first ever doubles result. */
export function isNewDoublesPeak(freshTotal: number, currentPeak: DoublesPeakRankingEntry | null): boolean {
  return currentPeak === null || freshTotal > currentPeak.peakPoints;
}
