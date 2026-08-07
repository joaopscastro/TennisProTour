import { AgeRange, ageInterpolationFactor } from '../player/PlayerGenerationPolicy';

/**
 * Domain service seam for pricing a talent-pool claim in XP — same
 * swappable-policy pattern as ManagerXpPolicy/TrainingPolicy/
 * RankingPointsTable. Takes a candidate's `overallRating()` (0-100,
 * PlayerAttributes.overallRating() — reused directly rather than
 * inventing a second "how good is this player" number, per
 * docs/manager-xp-and-coaching-system.md section 2) AND their age —
 * see StandardTalentClaimPricingPolicy's doc comment for why age
 * matters here at all: pricing is blended across the same generated
 * age span (`ageRange`, caller-supplied — same "not a constant this
 * policy bakes in" discipline as PlayerGenerationPolicy.generate's own
 * `ageRange` parameter) a candidate could have been generated within.
 */
export interface TalentClaimPricingPolicy {
  /** XP cost to claim a candidate with this overall rating, generated
   * at this age, within this age range. */
  priceFor(overallRating: number, ageInWeeks: number, ageRange: AgeRange): number;
}

/**
 * Illustrative, not balanced — same caveat as every other Standard*
 * policy in this codebase (StandardManagerXpPolicy, StandardTrainingPolicy,
 * StandardRankingPointsTable): placeholder constants safe to ship for
 * validating the architecture, not a tuned final formula.
 *
 * **Blended pricing, not a single formula.** At the YOUNGEST age a
 * candidate could have been generated at, price is flat — the same
 * BASE_COST for a weak or strong prospect alike, since a 14-year-old's
 * current ability barely predicts anything about what they'll become
 * (scouting's own potentialTier noise makes exactly this same point —
 * see PlayerGenerationPolicy.noiseProbabilityForAge). As generated age
 * increases toward the OLDEST the range allows, the ORIGINAL
 * super-linear ability-based formula (cost = BASE_COST *
 * (rating/PIVOT_RATING)^EXPONENT — unchanged from before this pass)
 * progressively takes over, reaching it fully at the oldest age: an
 * older prospect's current ability is a much more honest signal of
 * what a manager is actually paying for, so it should be priced like
 * one. The blend factor reuses `ageInterpolationFactor` — the EXACT
 * same age-position formula `noiseProbabilityForAge` already uses for
 * scouting's potential-range uncertainty, not a second, independently-
 * tuned curve that happens to look similar.
 */
export class StandardTalentClaimPricingPolicy implements TalentClaimPricingPolicy {
  /** PLACEHOLDER: XP cost at exactly PIVOT_RATING — ALSO the flat price
   * every candidate costs at the youngest generated age, regardless of
   * rating. Not tuned. */
  private static readonly BASE_COST = 50;

  /** PLACEHOLDER: the overallRating a claim costs exactly BASE_COST at,
   * once ability-based pricing is fully in effect (oldest age). Not
   * tuned. */
  private static readonly PIVOT_RATING = 50;

  /** PLACEHOLDER: super-linear growth factor — how much more steeply
   * cost rises above BASE_COST as rating climbs above PIVOT_RATING,
   * once ability-based pricing is fully in effect (oldest age). Not
   * tuned. */
  private static readonly EXPONENT = 2.5;

  private static abilityPrice(overallRating: number): number {
    const ratio = Math.max(0, overallRating) / StandardTalentClaimPricingPolicy.PIVOT_RATING;
    return StandardTalentClaimPricingPolicy.BASE_COST * Math.pow(ratio, StandardTalentClaimPricingPolicy.EXPONENT);
  }

  priceFor(overallRating: number, ageInWeeks: number, ageRange: AgeRange): number {
    const t = ageInterpolationFactor(ageInWeeks, ageRange); // 0 at youngest (flat), 1 at oldest (fully ability-based)
    const flatPrice = StandardTalentClaimPricingPolicy.BASE_COST;
    const abilityPrice = StandardTalentClaimPricingPolicy.abilityPrice(overallRating);
    const blended = flatPrice * (1 - t) + abilityPrice * t;
    return Math.round(blended);
  }
}
