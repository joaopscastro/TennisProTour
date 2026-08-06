import { WEEKS_PER_SEASON } from '../world/GameWorld';

/**
 * Domain service seam for converting a rostered player into a coach —
 * same swappable-policy pattern as ManagerXpPolicy/TalentClaimPricingPolicy.
 * Both outputs derive from the same two inputs (the source player's
 * `overallRating()` and their age at conversion, per
 * docs/manager-xp-and-coaching-system.md section 4), so one policy
 * bundles both rather than splitting into two separately-injected
 * policies that would always need to agree on the same inputs anyway.
 */
export interface CoachConversionPolicy {
  /** The resulting Coach's single coachRating — an older, more
   * accomplished player should produce a better coach. */
  coachRatingFor(overallRating: number, ageInWeeks: number): number;
  /** XP cost to perform the conversion — an older, more accomplished
   * player should also cost more to convert, matching coachRatingFor's
   * inputs exactly (a manager converting a player can see both numbers
   * move together, not from two unrelated formulas). */
  conversionCostFor(overallRating: number, ageInWeeks: number): number;
}

/**
 * Illustrative, not balanced — same caveat as every other Standard*
 * policy in this codebase. Placeholder constants, not tuned.
 *
 * Both outputs scale with overallRating (0-100) and age in seasons
 * (ageInWeeks / WEEKS_PER_SEASON): coachRating = BASE_RATING +
 * RATING_PER_OVERALL * overallRating + RATING_PER_SEASON * ageInSeasons,
 * capped at MAX_COACH_RATING so a coach's bonus (see
 * TrainingPolicy.applyCoachBonus) stays bounded. conversionCostFor
 * follows the same linear shape in COST_* terms — deliberately linear
 * rather than TalentClaimPricingPolicy's super-linear curve, since a
 * conversion is a one-time roster decision a manager makes once they
 * already own the player (not a competitive scarce-resource bidding
 * war the way claiming a new candidate is), so there's no equivalent
 * "disproportionate cost for strength" pressure to model here.
 */
export class StandardCoachConversionPolicy implements CoachConversionPolicy {
  /** PLACEHOLDER: coachRating floor, even for a weak/young conversion. Not tuned. */
  private static readonly BASE_RATING = 10;
  /** PLACEHOLDER: coachRating gained per point of overallRating. Not tuned. */
  private static readonly RATING_PER_OVERALL = 0.5;
  /** PLACEHOLDER: coachRating gained per season of age at conversion. Not tuned. */
  private static readonly RATING_PER_SEASON = 1.5;
  /** PLACEHOLDER: hard ceiling on coachRating. Not tuned. */
  private static readonly MAX_COACH_RATING = 100;

  /** PLACEHOLDER: XP cost floor. Not tuned. */
  private static readonly BASE_COST = 30;
  /** PLACEHOLDER: XP cost per point of overallRating. Not tuned. */
  private static readonly COST_PER_OVERALL = 1.2;
  /** PLACEHOLDER: XP cost per season of age at conversion. Not tuned. */
  private static readonly COST_PER_SEASON = 4;

  coachRatingFor(overallRating: number, ageInWeeks: number): number {
    const ageInSeasons = ageInWeeks / WEEKS_PER_SEASON;
    const rating =
      StandardCoachConversionPolicy.BASE_RATING +
      StandardCoachConversionPolicy.RATING_PER_OVERALL * overallRating +
      StandardCoachConversionPolicy.RATING_PER_SEASON * ageInSeasons;
    return Math.round(Math.min(rating, StandardCoachConversionPolicy.MAX_COACH_RATING));
  }

  conversionCostFor(overallRating: number, ageInWeeks: number): number {
    const ageInSeasons = ageInWeeks / WEEKS_PER_SEASON;
    const cost =
      StandardCoachConversionPolicy.BASE_COST +
      StandardCoachConversionPolicy.COST_PER_OVERALL * overallRating +
      StandardCoachConversionPolicy.COST_PER_SEASON * ageInSeasons;
    return Math.round(cost);
  }
}
