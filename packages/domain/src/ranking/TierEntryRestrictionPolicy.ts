import { TournamentTier } from '../competition/CompetitionTypes';

/**
 * Ranking-based tier entry restrictions — the senior-tour rule that a
 * player whose ranking is already too good may not drop down into a
 * lower tier, mirroring real ATP/ITF entry restrictions where a
 * well-ranked player is not admitted to the developmental rungs of the
 * ladder.
 *
 * Batch 4B (52-week agent season finding F1) split the rule into two
 * genuinely different shapes, because the old single hard bar made a
 * top player's weekly decision degenerate: from ~week 23 a top-50
 * player's only legal events were `tour` + `major`, and with one weekly
 * tour there was often literally nothing else legal to do (three
 * independent agents reported the same thing).
 *
 * 1. **`futures` — unchanged hard bar.** A top-`FUTURES_MAX_RANK`
 *    player may not enter a futures event, full stop. This is
 *    deliberately kept: it stops the strongest players farming the
 *    bottom rung, and it is not the constraint that caused the
 *    degeneracy (futures events are low-value anyway).
 *
 * 2. **`challenger` — a per-season SOFT CAP, not a hard bar.** A player
 *    ranked inside `CHALLENGER_MAX_RANK` may still enter challenger
 *    events, but only up to `CHALLENGER_SEASON_ENTRY_CAP` of them per
 *    season. Taking a challenger is now a real, bounded choice — spend
 *    one of a small number of season slots on a field you can probably
 *    win, or save them — instead of an impossibility. The
 *    anti-farming intent is preserved (three is nowhere near enough to
 *    hoover up the rung), while the top's weekly decision becomes
 *    "which event, which surface, which host" rather than play-or-rest.
 *
 * `tour` and `major` are unrestricted, and so is every junior tier —
 * this is a senior-tour rule only (the junior ladder is an age-based
 * circuit with its own eligibility rule in
 * `isAgeEligibleForTournamentBand`). An UNRANKED player ("NR" — no
 * qualifying result in the senior band) is never blocked: with no
 * earned ranking there is nothing to be "too good" for.
 *
 * All three numbers are explicit PLACEHOLDERs, flagged the same way
 * aging thresholds, `DIRECT_ACCEPTANCE_CUTOFF` and the ranking point
 * tables are — owned by the next agent-season validation pass, not
 * derived from a source.
 *
 * **Enforcement agreement, not aspiration:** the two registration use
 * cases and the player-scoped open-tournament preview all read the
 * exact same predicates/reason builders below, so a disabled row and a
 * rejected POST can never disagree. A known, deliberately disclosed
 * limitation: the per-season count itself is a read-then-write check
 * (like the hard bar it replaces, and like the coach-cap check), so two
 * near-simultaneous registrations by one player into two different
 * challenger events could in principle both pass before either lands —
 * the cap is a soft economy rule, not a race-critical invariant, and
 * closing that window would need a new season-scoped claim table for a
 * minor edge (see docs/CLAUDE.md's race-safety section for the
 * discipline this consciously stops short of).
 */

/** A senior rank at or better (numerically <=) than this may not enter a
 * `futures` event, at all. PLACEHOLDER — see this file's doc comment. */
export const FUTURES_MAX_RANK = 200;

/** Threshold for the challenger per-season soft cap: a rank at or better
 * than this is inside the cap. PLACEHOLDER — see this file's doc
 * comment. */
export const CHALLENGER_MAX_RANK = 50;

/** How many `challenger` events a player ranked inside
 * `CHALLENGER_MAX_RANK` may enter per season. PLACEHOLDER — see this
 * file's doc comment. */
export const CHALLENGER_SEASON_ENTRY_CAP = 3;

/**
 * The best (lowest) senior rank still admitted to each HARD-barred tier.
 * A tier absent from this map has no hard bar (`challenger` now uses the
 * soft cap instead; `tour`/`major`/every junior tier are unrestricted).
 */
const MAX_SENIOR_RANK_BY_TIER: Readonly<Partial<Record<TournamentTier, number>>> = {
  futures: FUTURES_MAX_RANK,
};

/** The per-season entry cap for each soft-capped tier, or absent when the
 * tier has none. `challenger` is the only soft-capped tier today. */
const SOFT_SEASON_CAP_BY_TIER: Readonly<Partial<Record<TournamentTier, number>>> = {
  challenger: CHALLENGER_SEASON_ENTRY_CAP,
};

/** The senior rank that triggers each soft-capped tier's season cap, or
 * absent when the tier has none. Kept separate from the cap number so a
 * future tier could cap a different slice of the ladder. */
const SOFT_CAP_CUTOFF_BY_TIER: Readonly<Partial<Record<TournamentTier, number>>> = {
  challenger: CHALLENGER_MAX_RANK,
};

/** The best senior rank admitted to `tier` under its HARD bar, or null
 * when the tier has no hard bar. */
export function maxSeniorRankForTier(tier: TournamentTier): number | null {
  return MAX_SENIOR_RANK_BY_TIER[tier] ?? null;
}

/** The per-season entry cap for a soft-capped tier, or null when the tier
 * has no soft cap. */
export function softSeasonCapForTier(tier: TournamentTier): number | null {
  return SOFT_SEASON_CAP_BY_TIER[tier] ?? null;
}

/** The rank that triggers a soft-capped tier's season cap, or null when
 * the tier has no soft cap. */
export function softCapCutoffForTier(tier: TournamentTier): number | null {
  return SOFT_CAP_CUTOFF_BY_TIER[tier] ?? null;
}

/** Whether a tier's rule needs the player's live senior rank read at all
 * — true for the hard bar (`futures`) AND the soft cap (`challenger`), so
 * both registration paths share one gate. Unrestricted tiers read nothing. */
export function tierUsesSeniorRank(tier: TournamentTier): boolean {
  return maxSeniorRankForTier(tier) !== null || softSeasonCapForTier(tier) !== null;
}

/**
 * Whether a player at the given senior rank (1-indexed; null = unranked)
 * is too highly ranked to enter `tier` — the HARD bar only (futures).
 * Pure predicate so the cutoff lives in exactly one place and every
 * caller reads the same decision. An unranked player (null) is never
 * blocked; an unrestricted tier never blocks anyone.
 */
export function isRankTooHighForTier(tier: TournamentTier, rank: number | null): boolean {
  if (rank === null) return false;
  const maxRank = maxSeniorRankForTier(tier);
  return maxRank !== null && rank <= maxRank;
}

/** Whether this rank sits inside a soft-capped tier's cutoff (and so is
 * subject to its per-season cap). Never true for an unranked player. */
export function isInsideSoftCapCutoff(tier: TournamentTier, rank: number | null): boolean {
  if (rank === null) return false;
  const cutoff = softCapCutoffForTier(tier);
  return cutoff !== null && rank <= cutoff;
}

/**
 * The plain-language reason a rank is refused at a tier's HARD bar, or
 * null when it is not — the ONE phrasing both the use-case refusal and
 * the preview reason use (e.g. "ranked #87 on the senior ladder — too
 * high to enter a futures event").
 */
export function seniorTierEntryRestrictionReason(tier: TournamentTier, rank: number | null): string | null {
  if (!isRankTooHighForTier(tier, rank)) return null;
  return `ranked #${rank} on the senior ladder — too high to enter a ${tier} event`;
}

/**
 * The plain-language reason a soft-capped player is refused once the
 * season cap is used up, or null when the cap does not apply or is not
 * yet reached. `entriesUsed` is the player's real season count (singles
 * OR doubles, deduped by tournament — see
 * TournamentRepository.countTierEntriesForSeason). Same "one phrasing,
 * shared by refusal and preview" discipline as the hard-bar reason above.
 */
export function seasonSoftCapRefusalReason(
  tier: TournamentTier,
  rank: number | null,
  entriesUsed: number,
): string | null {
  if (!isInsideSoftCapCutoff(tier, rank)) return null;
  const cap = softSeasonCapForTier(tier);
  const cutoff = softCapCutoffForTier(tier);
  if (cap === null || cutoff === null) return null;
  if (entriesUsed < cap) return null;
  return (
    `ranked #${rank} on the senior ladder — top-${cutoff} players may enter ${cap} ${tier} events ` +
    `per season, and all ${cap} are used`
  );
}
