import { AgeBand } from '../competition/CompetitionTypes';

/**
 * Which of a player's independent rankings a query/calculation is
 * scoped to. `'senior'` is the existing tour ranking (every
 * senior-tier result — `ageBand === null`); `'u14'`/`'u16'` are the two
 * independent junior-ladder rankings (see `RankingLedgerEntry.ageBand`
 * and `Tournament.ageBand`). A player's U14 results never feed their
 * U16 total or vice versa, and neither feeds the senior total — this
 * type plus `matchesRankingBand` is the one place that scoping rule is
 * expressed, so every caller (RankPositionQuery today, any future
 * per-band read model) reuses it instead of re-deriving the filter.
 */
export type RankingBand = 'senior' | AgeBand;

export function matchesRankingBand(entryAgeBand: AgeBand | null, band: RankingBand): boolean {
  return band === 'senior' ? entryAgeBand === null : entryAgeBand === band;
}

/**
 * The real ATP-derived rule this game already used for the senior tour
 * (best 18 of a rolling 52-week window) vs. the real ITF rule for
 * either junior band (best 6 — see
 * docs/junior-circuit-research-and-proposal.md's "same rolling-ranking
 * shape" section). `RankingCalculationService` itself stays band-
 * agnostic — it just takes a `bestResultsCap` number — this function
 * is the one place that number is tied to a band, so it's a
 * parameterization of the existing service rather than a second
 * calculation path.
 */
export function bestResultsCapFor(band: RankingBand): number {
  return band === 'senior' ? 18 : 6;
}

/** Real age cutoffs, not tunable placeholders — literally what
 * "U14"/"U16" mean (see docs/junior-circuit-research-and-proposal.md's
 * scope note excluding U12: real ITF/Tennis Europe U12 play is
 * unranked and unseeded, so there's no third junior band here).
 * INCLUSIVE on the upper end of each band, matching real Tennis
 * Europe eligibility ("14-and-under" / "16-and-under") — a player who
 * is EXACTLY 14.000 years old (728 weeks) is still U14-eligible, not
 * already U16; exactly 16.000 years old (832 weeks) is still
 * U16-eligible, not already senior. See juniorEligibilityForAge's own
 * comment for why this matters beyond pedantry: it was a real bug,
 * not just an edge case, because TALENT_POOL_AGE_RANGE's minimum age
 * sits EXACTLY on this boundary — under the old strict `<` check, no
 * generated player could ever land in U14 at all, only U16 or older. */
const U14_MAX_AGE_WEEKS = 14 * 52;
const U16_MAX_AGE_WEEKS = 16 * 52;

/**
 * A player's CURRENT junior-ladder eligibility, purely a function of
 * age — distinct from which tournaments they've actually entered
 * (`Tournament.ageBand` is chosen per-tournament, not derived from
 * this; a 15-year-old could still be entered into a U16 draw, or, per
 * real ITF age-eligibility rules this game doesn't enforce, even play
 * up). This is what `AdvanceWorldWeekUseCase` compares week-over-week
 * to detect a graduation crossing (see GraduationCarryover.ts) — a
 * player ages by exactly one week per tick and the two boundaries are
 * 104 weeks apart, so a single tick can never cross more than one
 * boundary, and comparing before/after is sufficient without needing
 * to enumerate which specific crossing happened.
 */
export function juniorEligibilityForAge(ageInWeeks: number): RankingBand {
  if (ageInWeeks <= U14_MAX_AGE_WEEKS) return 'u14';
  if (ageInWeeks <= U16_MAX_AGE_WEEKS) return 'u16';
  return 'senior';
}

/**
 * Whether a player of this age may register for a tournament scoped
 * to `tournamentAgeBand` (`null` = senior tour). This is deliberately
 * ONE-DIRECTIONAL, matching how age eligibility actually works in real
 * tennis:
 *
 * - The senior tour (`null`) has no age floor or ceiling here — a
 *   junior player entering senior events is normal (many top players
 *   turn pro before 18), not a gap to close. Nothing about this
 *   function restricts that direction; it only ever returns `false`
 *   for a REAL junior tournament (`u14`/`u16`).
 * - A player may "play up" into an OLDER band than their own current
 *   eligibility (a U14-eligible player entering a U16 draw) — a real,
 *   intentionally-permitted case, not an oversight (see
 *   `juniorEligibilityForAge`'s own doc comment, which already flagged
 *   this as a case this game should allow). A senior player, or a
 *   U16-eligible player, may NOT play down into `u14` — you cannot
 *   become younger than you are.
 *
 * This is the fix for the previously-disclosed gap ("nothing enforces
 * a registering player's actual age against a tournament's ageBand" —
 * see CLAUDE.md/RegisterEntrantUseCase's prior doc comment): the gap
 * only ever needed closing in the "too old for this junior draw"
 * direction; the "too young for senior" direction was never a gap at
 * all, since real tennis doesn't restrict it either.
 */
export function isAgeEligibleForTournamentBand(ageInWeeks: number, tournamentAgeBand: AgeBand | null): boolean {
  if (tournamentAgeBand === null) return true;
  const playerBand = juniorEligibilityForAge(ageInWeeks);
  if (tournamentAgeBand === 'u14') return playerBand === 'u14';
  return playerBand === 'u14' || playerBand === 'u16';
}
