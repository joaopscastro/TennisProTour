/**
 * Domain service seam for pricing a talent-pool claim in XP — same
 * swappable-policy pattern as ManagerXpPolicy/TrainingPolicy/
 * RankingPointsTable. Takes a candidate's `overallRating()` (0-100,
 * PlayerAttributes.overallRating() — reused directly rather than
 * inventing a second "how good is this player" number, per
 * docs/manager-xp-and-coaching-system.md section 2) as its only input.
 */
export interface TalentClaimPricingPolicy {
  /** XP cost to claim a candidate with this overall rating. */
  priceFor(overallRating: number): number;
}

/**
 * Illustrative, not balanced — same caveat as every other Standard*
 * policy in this codebase (StandardManagerXpPolicy, StandardTrainingPolicy,
 * StandardRankingPointsTable): placeholder constants safe to ship for
 * validating the architecture, not a tuned final formula.
 *
 * Formula: cost = BASE_COST * (rating / PIVOT_RATING) ^ EXPONENT, per
 * the source doc's recommended shape — super-linear (EXPONENT > 1) so
 * strong players are disproportionately expensive relative to mediocre
 * ones, not just a flat per-rating-point cost. PIVOT_RATING is the
 * rating at which cost == BASE_COST exactly (a rough "average" player,
 * since starting attributes in this game center near 30-40 and a
 * strong veteran can reach into the 70s-80s).
 */
export class StandardTalentClaimPricingPolicy implements TalentClaimPricingPolicy {
  /** PLACEHOLDER: XP cost at exactly PIVOT_RATING. Not tuned. */
  private static readonly BASE_COST = 50;

  /** PLACEHOLDER: the overallRating a claim costs exactly BASE_COST at.
   * Not tuned. */
  private static readonly PIVOT_RATING = 50;

  /** PLACEHOLDER: super-linear growth factor — how much more steeply
   * cost rises above BASE_COST as rating climbs above PIVOT_RATING.
   * Not tuned. */
  private static readonly EXPONENT = 2.5;

  priceFor(overallRating: number): number {
    const ratio = Math.max(0, overallRating) / StandardTalentClaimPricingPolicy.PIVOT_RATING;
    const cost = StandardTalentClaimPricingPolicy.BASE_COST * Math.pow(ratio, StandardTalentClaimPricingPolicy.EXPONENT);
    return Math.round(cost);
  }
}
