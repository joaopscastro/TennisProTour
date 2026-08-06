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
 * unranked and unseeded, so there's no third junior band here). */
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
  if (ageInWeeks < U14_MAX_AGE_WEEKS) return 'u14';
  if (ageInWeeks < U16_MAX_AGE_WEEKS) return 'u16';
  return 'senior';
}
