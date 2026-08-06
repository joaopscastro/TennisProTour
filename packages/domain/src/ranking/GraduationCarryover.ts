import { RankingBand } from './RankingBand';

/**
 * PLACEHOLDER — explicit and unsourced, distinct from the real
 * ITF-sourced J-grade champion point values StandardRankingPointsTable
 * uses (see CompetitionTypes.ts). What fraction of a player's ranking
 * total in the band they're leaving carries over as a one-time bonus.
 * Not derived from any real ITF/Tennis Europe rule — see
 * docs/junior-circuit-research-and-proposal.md's "Finalized design"
 * item 4: the real system's 200%-weighted transition works differently
 * (dual counting during a transition window), which is more mechanism
 * than this needs, so a simpler one-time bonus stands in for it. Tune
 * before launch, same caveat CLAUDE.md already applies to every other
 * placeholder constant in this codebase.
 */
export const GRADUATION_CARRYOVER_FRACTION = 0.5;

/**
 * A carryover bonus recorded at the moment a player crosses an
 * age-band boundary, sitting inert on the player until consumed. Never
 * a ranking-ledger entry by itself — see this module's doc comment on
 * `applyGraduationCarryover` for why.
 */
export interface DormantCarryoverBonus {
  /** The band this bonus is waiting for — must match the RankingBand
   * of a player's next real (points > 0) ranking-ledger entry before
   * it fires. A player graduating U16 -> senior while an older,
   * unconsumed U14 -> U16 bonus still sits dormant simply overwrites
   * it: that U16 bonus never fired because the player never won a U16
   * match to consume it, so it's moot the moment they've left U16
   * entirely. */
  readonly targetBand: RankingBand;
  /** Points added to the first qualifying entry — computed once, at
   * graduation, as `oldBandTotal * GRADUATION_CARRYOVER_FRACTION`.
   *
   * Framed elsewhere as "applying a multiplier to that entry's
   * points," which this number makes literally true without needing
   * its own separate ratio field: boosting an entry from `points` to
   * `points + bonusPoints` is exactly the same thing as multiplying it
   * by `1 + bonusPoints / points` — a multiplier whose value can only
   * be known once the entry's real points are (which is exactly why
   * this has to sit dormant instead of being resolved at graduation
   * time; the entry it will apply to doesn't exist yet).
   */
  readonly bonusPoints: number;
}

/**
 * Computes the dormant bonus to record at the moment a player crosses
 * into `targetBand`, from their current total in the band they're
 * leaving. Returns null (record nothing) when that total is 0 — a
 * player with no ranking at all in the band they're leaving (never won
 * a match there) has nothing to carry over; recording a bonus worth 0
 * points would be a no-op that just clutters the player's state.
 *
 * Deliberately does NOT create a ranking-ledger entry, here or
 * anywhere else in this module — per the "rankings must be earned, not
 * granted" correction in the research doc, a ranking may only ever
 * come into existence through an actual won match. This function only
 * ever produces a dormant value sitting on the player; only
 * `applyGraduationCarryover`, called from the same place real
 * ranking-ledger entries are written (SimulateMatchUseCase), can turn
 * it into points, and only by amplifying a result that already exists
 * for an unrelated, genuine reason (the player won a match).
 */
export function computeGraduationCarryover(targetBand: RankingBand, oldBandTotal: number): DormantCarryoverBonus | null {
  if (oldBandTotal <= 0) return null;
  return { targetBand, bonusPoints: oldBandTotal * GRADUATION_CARRYOVER_FRACTION };
}

/**
 * Given a freshly-computed ranking-ledger entry's points, its band,
 * and whatever dormant bonus (if any) the player is currently holding,
 * decides whether this is the qualifying moment to consume it: the
 * entry must be in the bonus's target band, AND must itself already be
 * a real, positive-points result (roundsWon >= 1 — see
 * StandardRankingPointsTable's roundsWon=0 fix). A first-round exit in
 * the new band does NOT consume the bonus — "once they actually play
 * and win," per the research doc, not merely play. Returns the
 * boosted points and a flag telling the caller whether to clear the
 * bonus; never mutates anything itself (stays a pure function, same as
 * every other ranking calculation in this file/module).
 */
export function applyGraduationCarryover(
  points: number,
  entryBand: RankingBand,
  dormant: DormantCarryoverBonus | null,
): { points: number; consumed: boolean } {
  if (points > 0 && dormant && dormant.targetBand === entryBand) {
    return { points: points + dormant.bonusPoints, consumed: true };
  }
  return { points, consumed: false };
}
