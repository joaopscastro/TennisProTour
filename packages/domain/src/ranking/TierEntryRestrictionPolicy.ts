import { TournamentTier } from '../competition/CompetitionTypes';

/**
 * Ranking-based tier entry restrictions — the senior-tour rule that a
 * player whose ranking is already too good may not drop down into a
 * lower tier. Mirrors real ATP/ITF entry restrictions, where a
 * well-ranked player is simply not admitted to the developmental rungs
 * of the ladder.
 *
 * The rule, as one sentence: a top-`FUTURES_MAX_RANK` player may not
 * enter a `futures` event, and a top-`CHALLENGER_MAX_RANK` player may
 * not enter a `challenger` event. `tour` and `major` are unrestricted,
 * and so is every junior tier — this is a senior-tour rule only (the
 * junior ladder is an age-based circuit with its own eligibility rule
 * in `isAgeEligibleForTournamentBand`). An UNRANKED player ("NR" — no
 * qualifying result in the senior band) is never blocked: with no
 * earned ranking there is nothing to be "too good" for.
 *
 * Why this exists: it stops a strong player farming weak tiers (a
 * top-50 player hoovering up `challenger` titles and points), and it
 * makes "which tournament should I enter?" a real decision, because a
 * player's eligible list now narrows meaningfully as their rank rises
 * instead of every tier staying open forever.
 *
 * The two cutoffs are explicit PLACEHOLDER numbers, flagged the same
 * way aging thresholds, `DIRECT_ACCEPTANCE_CUTOFF` and the ranking
 * point tables are — owned by the balance-tuning pass, not derived from
 * a source. They are chosen only to sit sensibly against the game's
 * tiers: 200 keeps a genuinely ranked-but-not-elite player out of the
 * bottom rung, 50 keeps the top of the ladder out of the middle rung.
 */

/** A senior rank at or better (numerically <=) than this may not enter a
 * `futures` event. PLACEHOLDER — see this file's doc comment. */
export const FUTURES_MAX_RANK = 200;

/** A senior rank at or better (numerically <=) than this may not enter a
 * `challenger` event. PLACEHOLDER — see this file's doc comment. */
export const CHALLENGER_MAX_RANK = 50;

/**
 * The best (lowest) senior rank still admitted to each restricted tier.
 * A tier absent from this map is unrestricted (`tour`, `major`, every
 * junior tier). A set/map rather than hardcoded pairwise comparisons,
 * so a future restricted tier is added here without touching any
 * caller.
 */
const MAX_SENIOR_RANK_BY_TIER: Readonly<Partial<Record<TournamentTier, number>>> = {
  futures: FUTURES_MAX_RANK,
  challenger: CHALLENGER_MAX_RANK,
};

/** The best senior rank admitted to `tier`, or null when the tier has no
 * ranking restriction at all. */
export function maxSeniorRankForTier(tier: TournamentTier): number | null {
  return MAX_SENIOR_RANK_BY_TIER[tier] ?? null;
}

/**
 * Whether a player at the given senior rank (1-indexed; null = unranked)
 * is too highly ranked to enter `tier`. Pure predicate so the cutoff
 * lives in exactly one place and every caller — the registration use
 * cases AND the player-scoped open-tournament preview — reads the same
 * decision and can never disagree. An unranked player (null) is never
 * blocked; an unrestricted tier never blocks anyone.
 */
export function isRankTooHighForTier(tier: TournamentTier, rank: number | null): boolean {
  if (rank === null) return false;
  const maxRank = maxSeniorRankForTier(tier);
  return maxRank !== null && rank <= maxRank;
}

/**
 * The plain-language reason a rank is refused at a tier, or null when it
 * is not — the ONE phrasing both the use-case refusal and the preview
 * reason use, so the message a manager sees up front is literally the
 * same one a rejected POST would produce (e.g. "ranked #87 on the
 * senior ladder — too high to enter a futures event").
 */
export function seniorTierEntryRestrictionReason(tier: TournamentTier, rank: number | null): string | null {
  if (!isRankTooHighForTier(tier, rank)) return null;
  return `ranked #${rank} on the senior ladder — too high to enter a ${tier} event`;
}
