import { TournamentTier } from '../competition/CompetitionTypes';

/**
 * Domain service seam for converting a single match result into manager
 * XP — same swappable-policy pattern as RankingPointsTable
 * (CompetitionTypes.ts) and TrainingPolicy: XP-per-result is a tunable
 * formula, not something SimulateMatchUseCase or Player should compute
 * inline. XP is a simple cumulative balance per manager (see
 * ManagerXpRepository), never a rolling/decaying ledger like rankings —
 * it's a spendable currency, not a competitive standing.
 */
export interface ManagerXpPolicy {
  /** XP a manager earns for one rostered player's deciding match result
   * (elimination loss, or the final win) at the given tournament tier. */
  xpFor(result: 'win' | 'loss', tier: TournamentTier): number;
}

/**
 * Illustrative, not balanced — same caveat as StandardTrainingPolicy's
 * BASE_GAIN table and StandardRankingPointsTable's points formula:
 * placeholder constants safe to ship for validating the architecture,
 * but worth a dedicated tuning pass before launch.
 *
 * Formula: xp = BASE_XP * tierMultiplier + (win ? WIN_BONUS : 0). The
 * per-tier multiplier scales the PARTICIPATION component only, reusing
 * the same tier ordering ranking points already use (major > tour >
 * challenger > futures, with the junior ladder as its own separate,
 * lower scale below futures); a WIN's bonus is added on top at a flat
 * rate, never multiplied down by a low tier's factor and never shrinking
 * a low tier's win below a high tier's mere participation.
 *
 * **Why the win bonus sits OUTSIDE the multiplier — a real, deliberate
 * correction of the original `(BASE_XP + bonus) * multiplier` shape.**
 * With the bonus folded into the multiplier, a low tier shrank the win
 * component while a high tier inflated the participation component, so
 * a MAJOR first-round LOSS (10 × 5 = 50) out-earned a FUTURES TITLE
 * (25 × 1.5 = 38) — directly contradicting this project's own
 * "ranked to win, never paid for showing up" principle (CLAUDE.md
 * design principle #1 and the ranking-points rule that a first-round
 * loss earns zero). Keeping the bonus additive structurally guarantees
 * the intended property: because WIN_BONUS (60) exceeds
 * BASE_XP × (max multiplier − min multiplier) = 10 × (5 − 0.5) = 45,
 * a title at ANY tier always out-earns a first-round loss at ANY tier,
 * while higher tiers still pay strictly more for the same result.
 */
export class StandardManagerXpPolicy implements ManagerXpPolicy {
  /** PLACEHOLDER: base XP for any deciding result, before the tier
   * multiplier — participation has some value. Not tuned. */
  private static readonly BASE_XP = 10;

  /** PLACEHOLDER: flat extra XP for a WIN, added AFTER the tier
   * multiplier so it can never be shrunk by a low tier. Not tuned, but
   * sized (60 > 45) so it structurally guarantees a title at any tier
   * beats a first-round loss at any tier — the actual point of this
   * shape, not an arbitrary value. */
  private static readonly WIN_BONUS = 60;

  /** PLACEHOLDER: per-tier multiplier applied to BASE_XP only. Senior
   * tiers keep the original major > tour > challenger > futures
   * ordering. The junior ladder is its own separate, lower-XP scale
   * below futures, ascending with grade (j30 lowest, juniorMasters
   * highest) — junior and senior XP aren't meant to be on one
   * continuous curve, same "junior is its own graduated system" scope
   * decision as the ranking ladder itself
   * (docs/junior-circuit-research-and-proposal.md). Not tuned. */
  private static readonly TIER_MULTIPLIER: Record<TournamentTier, number> = {
    major: 5,
    tour: 3,
    challenger: 2,
    futures: 1.5,
    juniorMasters: 1.4,
    j500: 1.3,
    j300: 1.15,
    j200: 1,
    j100: 0.85,
    j60: 0.7,
    j30: 0.5,
  };

  xpFor(result: 'win' | 'loss', tier: TournamentTier): number {
    const participation = StandardManagerXpPolicy.BASE_XP * StandardManagerXpPolicy.TIER_MULTIPLIER[tier];
    const winBonus = result === 'win' ? StandardManagerXpPolicy.WIN_BONUS : 0;
    return Math.round(participation + winBonus);
  }
}
