import { AgeBand } from '../competition/CompetitionTypes';

/**
 * Which of a player's independent rankings a query/calculation is
 * scoped to. `'senior'` is the existing tour ranking (every
 * senior-tier result — `ageBand === null`); `'u14'`/`'u16'`/`'u18'` are
 * the three independent junior-ladder rankings (see
 * `RankingLedgerEntry.ageBand` and `Tournament.ageBand`). A player's
 * U14 results never feed their U16 or U18 total or vice versa, and none
 * of the three feeds the senior total — this
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
 * "U14"/"U16"/"U18" mean (see docs/junior-circuit-research-and-proposal.md's
 * scope note excluding U12: real ITF/Tennis Europe U12 play is
 * unranked and unseeded, so there's no U12 band here).
 * INCLUSIVE on the upper end of each band, matching real Tennis
 * Europe eligibility ("14-and-under" / "16-and-under" / "18-and-under")
 * — a player whose ELIGIBILITY AGE (see juniorEligibilityForAge's doc
 * comment — this is never the same as literal current age) is EXACTLY
 * 14.000 years old (728 weeks) is still U14-eligible, not already U16;
 * exactly 16.000 years old (832 weeks) is still U16-eligible, not
 * already U18; exactly 18.000 years old (936 weeks) is still
 * U18-eligible, not already senior-only. This mattered as a real bug
 * before the boundary was made inclusive — see this function's own
 * history in CLAUDE.md. */
const U14_MAX_AGE_WEEKS = 14 * 52;
const U16_MAX_AGE_WEEKS = 16 * 52;
const U18_MAX_AGE_WEEKS = 18 * 52;

/** Every junior band, youngest to oldest — the one place "play up" order
 * is expressed, so `isAgeEligibleForTournamentBand` never has to
 * hardcode pairwise comparisons that'd need touching every time a band
 * is added or removed. */
const AGE_BAND_ORDER: readonly AgeBand[] = ['u14', 'u16', 'u18'];

/**
 * Which junior band a player is eligible for, GIVEN an age in weeks —
 * but this is deliberately NOT a function of a player's literal
 * CURRENT age. Real ITF/Tennis Europe age-category eligibility is
 * fixed for an entire competitive year by the player's age as of
 * January 1 of that year (in this game's terms: game-week 1 of the
 * current season) — a player who turns 14 in June still plays U14 for
 * the rest of that year. Every real call site must pass
 * `Player.seasonAgeAnchorWeeks` (which IS frozen at that January-1
 * value — see its own doc comment), never `Player.ageInWeeks` directly;
 * this function itself stays a pure, agnostic age->band lookup so its
 * unit tests don't need to know or care which age concept a caller is
 * feeding it. This is what `AdvanceWorldWeekUseCase` compares
 * before/after `anchorSeasonAge()` at a season rollover to detect a
 * graduation crossing (see GraduationCarryover.ts) — the anchor only
 * ever changes once a season, so that's the only tick a crossing can
 * happen on.
 */
export function juniorEligibilityForAge(ageInWeeks: number): RankingBand {
  if (ageInWeeks <= U14_MAX_AGE_WEEKS) return 'u14';
  if (ageInWeeks <= U16_MAX_AGE_WEEKS) return 'u16';
  if (ageInWeeks <= U18_MAX_AGE_WEEKS) return 'u18';
  return 'senior';
}

/**
 * Whether a player of this ELIGIBILITY age (see juniorEligibilityForAge's
 * doc comment — the caller must pass `Player.seasonAgeAnchorWeeks`,
 * never `Player.ageInWeeks`) may register for a tournament scoped to
 * `tournamentAgeBand` (`null` = senior tour). This is deliberately
 * ONE-DIRECTIONAL, matching how age eligibility actually works in real
 * tennis:
 *
 * - The senior tour (`null`) has no age floor or ceiling here — a
 *   junior player entering senior events is normal (many top players
 *   turn pro before 18), not a gap to close. Nothing about this
 *   function restricts that direction; it only ever returns `false`
 *   for a REAL junior tournament (`u14`/`u16`/`u18`).
 * - A player may "play up" into an OLDER band than their own current
 *   eligibility (a U14-eligible player entering a U16 or U18 draw) —
 *   a real, intentionally-permitted case, not an oversight (see
 *   `juniorEligibilityForAge`'s own doc comment, which already flagged
 *   this as a case this game should allow). A senior player, or a
 *   U16-eligible player, may NOT play down into `u14` — you cannot
 *   become younger than you are. Expressed generically via
 *   AGE_BAND_ORDER's index rather than pairwise band comparisons, so
 *   this logic doesn't need touching if a band is ever added/removed.
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
  if (playerBand === 'senior') return false;
  const playerIndex = AGE_BAND_ORDER.indexOf(playerBand);
  const tournamentIndex = AGE_BAND_ORDER.indexOf(tournamentAgeBand);
  return playerIndex <= tournamentIndex;
}
