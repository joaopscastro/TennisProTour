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
 *
 * conversionCostFor is capped the moment the SAME uncapped rating
 * calculation would already be at or past MAX_COACH_RATING — not an
 * independent cost-side threshold — so cost and rating always plateau
 * together: past whatever ability/age combination first saturates
 * coachRating, paying more XP buys nothing further. The plateau value
 * (MAX_CONVERSION_COST) is deliberately its OWN flagged constant
 * rather than "whatever the linear cost formula happens to equal right
 * at the boundary": many different (overallRating, ageInWeeks) pairs
 * can all reach exactly MAX_COACH_RATING (e.g. very old+moderate vs.
 * very able+younger), and the linear cost formula would value each of
 * those pairs differently — there is no single canonical "the"
 * threshold point to derive a plateau cost from. A flat constant is
 * what actually guarantees every saturated conversion costs the same,
 * regardless of how it got there.
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
  /** PLACEHOLDER: flat XP cost once a conversion would already produce
   * a capped (MAX_COACH_RATING) coachRating — see this class's doc
   * comment for why this is its own constant, not derived at runtime
   * from COST_PER_OVERALL/COST_PER_SEASON at some "threshold" input
   * pair. Chosen at/above ~257 — the cost the linear formula gives
   * along the CHEAPEST possible path to exactly MAX_COACH_RATING
   * (overallRating maxed at 100, the minimum age needed to reach 100
   * rating from there) — specifically so a player who just barely
   * saturates the rating cap never sees cost go DOWN relative to a
   * player just below it; every more expensive path to saturation
   * (lower overall, more age) plateaus here too. Not tuned. */
  private static readonly MAX_CONVERSION_COST = 260;

  private static rawCoachRating(overallRating: number, ageInSeasons: number): number {
    return (
      StandardCoachConversionPolicy.BASE_RATING +
      StandardCoachConversionPolicy.RATING_PER_OVERALL * overallRating +
      StandardCoachConversionPolicy.RATING_PER_SEASON * ageInSeasons
    );
  }

  coachRatingFor(overallRating: number, ageInWeeks: number): number {
    const ageInSeasons = ageInWeeks / WEEKS_PER_SEASON;
    const rating = StandardCoachConversionPolicy.rawCoachRating(overallRating, ageInSeasons);
    return Math.round(Math.min(rating, StandardCoachConversionPolicy.MAX_COACH_RATING));
  }

  conversionCostFor(overallRating: number, ageInWeeks: number): number {
    const ageInSeasons = ageInWeeks / WEEKS_PER_SEASON;
    const rawRating = StandardCoachConversionPolicy.rawCoachRating(overallRating, ageInSeasons);
    if (rawRating >= StandardCoachConversionPolicy.MAX_COACH_RATING) {
      return StandardCoachConversionPolicy.MAX_CONVERSION_COST;
    }
    const cost =
      StandardCoachConversionPolicy.BASE_COST +
      StandardCoachConversionPolicy.COST_PER_OVERALL * overallRating +
      StandardCoachConversionPolicy.COST_PER_SEASON * ageInSeasons;
    return Math.round(cost);
  }
}
