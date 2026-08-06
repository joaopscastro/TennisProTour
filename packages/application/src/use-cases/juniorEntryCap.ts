/**
 * Real ITF rule, not a placeholder guess: "a player may enter up to
 * three ITF Junior Circuit tournaments in a single tournament week,
 * assigning a priority order to each entry" — see
 * docs/junior-circuit-research-and-proposal.md's "Real scheduling
 * constraints" section. 3, not 2, is the number to reuse here for the
 * same reason StandardRankingPointsTable reuses the real ITF point
 * ladder instead of inventing one: when a real, sourced number exists,
 * use it rather than a guess.
 *
 * This game doesn't model entry *priority* (the real rule's "assigning
 * a priority order to each entry" — what happens when two of a
 * player's three chosen tournaments schedule a clash) — just the flat
 * weekly ceiling, which is what actually creates the "which three"
 * decision tension the design doc calls out. Priority ordering is a
 * real, understood extension, not implemented here; revisit only if a
 * scheduling-conflict scenario actually needs it.
 *
 * Scoped to junior tournaments only — see RegisterEntrantUseCase's doc
 * comment for why the senior tour isn't capped the same way.
 */
export const JUNIOR_WEEKLY_ENTRY_CAP = 3;
