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
