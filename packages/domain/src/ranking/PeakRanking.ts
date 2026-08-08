import { GameWeek, PlayerId } from '../shared/ids';
import { RankingBand } from './RankingBand';

/**
 * A player's permanent high-water-mark ranking total in one band —
 * deliberately separate from RankingCalculationService's rolling
 * (and therefore sometimes-falling) total. Per
 * docs/data-archival-principles.md: one row per (player, band), never
 * append-only, updated in place. `peakAsOfWeek` records WHEN the peak
 * was last actually reached (display context — "peaked in season 2,
 * week 14" — not part of the ordering rule itself).
 */
export interface PeakRankingEntry {
  readonly playerId: PlayerId;
  readonly band: RankingBand;
  readonly peakPoints: number;
  readonly peakAsOfWeek: GameWeek;
}

/**
 * The one rule this whole feature exists to enforce: a peak can only
 * ever move up, never down. `currentPeak === null` means the player
 * has never had a peak recorded in this band yet (the very first
 * ranking-ledger write for them in it), which is trivially a new
 * peak. Strict `>` (not `>=`), matching the archival doc's "would
 * EXCEED the stored peak" wording — a freshly-computed total that
 * merely ties the existing peak isn't a new high, so it deliberately
 * does not trigger a write (see updatedAt/peakAsOfWeek's meaning:
 * touching it on a tie would misrepresent WHEN the peak was actually
 * reached).
 */
export function isNewPeak(freshTotal: number, currentPeak: PeakRankingEntry | null): boolean {
  return currentPeak === null || freshTotal > currentPeak.peakPoints;
}
