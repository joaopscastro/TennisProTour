import { DrawSize, TournamentTier } from './CompetitionTypes';

/** Whether a tier holds a doubles draw — EVERY tier does (P7b + junior
 * doubles in P7c/P8): senior tournaments and both junior bands all run
 * doubles, matching real tennis (the ITF junior circuit has doubles at
 * every grade). Kept as a predicate rather than a literal so a future
 * carve-out is one line. */
export function hasDoubles(_tier: TournamentTier): boolean {
  return true;
}

/** The size of a tier's doubles draw — roughly half the singles draw
 * (real tennis runs doubles draws about half the size of the singles
 * field). PLACEHOLDER, same tuning-pass status as the qualifying sizes;
 * stored at open time (see TournamentOpenProps.doublesDrawSize), never
 * re-derived per read. */
export function doublesDrawSizeFor(_tier: TournamentTier, drawSize: DrawSize): number {
  return Math.max(4, drawSize / 2);
}

// ---------------------------------------------------------------------------
// Doubles qualifying — draw-size-derived, not tier-derived (per the owner's
// design): whether a doubles draw holds qualifying, and how big it is, is a
// pure function of the doubles DRAW SIZE, so bigger draws get a qualifying
// event and small ones never do. Every constant is a PLACEHOLDER.
// ---------------------------------------------------------------------------

/** A doubles draw this big (or bigger) holds a qualifying event — below it
 * there is none ("not every tournament has doubles qualifying"). */
const DOUBLES_QUALIFYING_MIN_DRAW_SIZE = 16;

/** Fraction of the doubles main draw reserved for qualifiers — 1/8,
 * mirroring the singles QUALIFIER_SLOT_FRACTION. */
const DOUBLES_QUALIFIER_SLOT_FRACTION = 1 / 8;

/** Pairs contesting each reserved slot — 4, i.e. a two-round qualifying
 * bracket (never 2, which would be a one-round event whose winners can
 * include bye recipients — same structural constraint as the singles
 * qualifying draw). */
const DOUBLES_QUALIFYING_PLAYERS_PER_SLOT = 4;

export function hasDoublesQualifying(doublesDrawSize: number): boolean {
  return doublesDrawSize >= DOUBLES_QUALIFYING_MIN_DRAW_SIZE;
}

/** Main-draw places reserved for doubles qualifiers — 0 when the draw is
 * too small to hold qualifying. */
export function doublesQualifierSlotsFor(doublesDrawSize: number): number {
  if (!hasDoublesQualifying(doublesDrawSize)) return 0;
  return Math.floor(doublesDrawSize * DOUBLES_QUALIFIER_SLOT_FRACTION);
}

/** Size of the doubles QUALIFYING field (pairs contesting the reserved
 * slots) — 0 when there is no doubles qualifying. */
export function doublesQualifyingDrawSizeFor(doublesDrawSize: number): number {
  return doublesQualifierSlotsFor(doublesDrawSize) * DOUBLES_QUALIFYING_PLAYERS_PER_SLOT;
}

/** Rounds the doubles qualifying bracket plays — log2(players-per-slot) =
 * 2, so a qualifier always has a recorded win. 0 = no qualifying. */
export function doublesQualifyingRoundCountFor(doublesDrawSize: number): number {
  if (!hasDoublesQualifying(doublesDrawSize)) return 0;
  return Math.log2(DOUBLES_QUALIFYING_PLAYERS_PER_SLOT);
}

/** Ranking points for being eliminated in doubles qualifying, indexed by
 * qualifying rounds won — deliberately tiny, never approaching a main-draw
 * doubles result. Index 0 is 0 (a ranking is earned by winning). Index 1
 * (25) is the real, sourced value from the 2026 PIF ATP Rankings
 * rulebook (9.02.G.6, footnote ***): "The team losing in the final round
 * of qualifying shall receive 25 ranking points" — the only doubles
 * qualifying table the rulebook publishes (ATP Tour 500's 16-team
 * draw). This project's `doublesQualifyingRoundCountFor` always
 * produces exactly 2 qualifying rounds regardless of tier, matching
 * this table's own shape exactly: index 0 (lost round 1) is the real
 * "no points in the first round" rule, index 1 (lost round 2, the
 * final qualifying round) is the sourced 25 — no interpolation needed. */
const DOUBLES_QUALIFYING_POINTS: ReadonlyArray<number> = [0, 25];

export function doublesQualifyingPointsFor(qualifyingRoundsWon: number): number {
  return DOUBLES_QUALIFYING_POINTS[Math.min(qualifyingRoundsWon, DOUBLES_QUALIFYING_POINTS.length - 1)] ?? 0;
}

/** Doubles qualifying prize money — the money counterpart to
 * DOUBLES_QUALIFYING_POINTS, same PLACEHOLDER-dollar-figure caveat as
 * StandardPrizeMoneyTable. Index 0 is deliberately non-zero, unlike the
 * points table — same "paid to play, ranked to win" divergence
 * documented there: a pair that plays and loses its first qualifying
 * match still played a real match. */
const DOUBLES_QUALIFYING_PRIZE_MONEY: ReadonlyArray<number> = [300, 700];

export function doublesQualifyingPrizeMoneyFor(qualifyingRoundsWon: number): number {
  return DOUBLES_QUALIFYING_PRIZE_MONEY[Math.min(Math.max(qualifyingRoundsWon, 0), DOUBLES_QUALIFYING_PRIZE_MONEY.length - 1)] ?? 0;
}
