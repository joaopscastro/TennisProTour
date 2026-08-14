import { DrawSize, EntryType, TournamentTier } from '../competition/CompetitionTypes';
import { isEligibleForDirectAcceptance } from './ObligatoryTournamentPolicy';

/**
 * Tiers that hold a qualifying event at all — the other side of
 * `DIRECT_ACCEPTANCE_CUTOFF` (see ObligatoryTournamentPolicy and
 * docs/ranking-realism-proposal.md §5): above the cutoff a player is
 * granted a main-draw place AND owes the mandatory-skip obligation;
 * below it they must take one of the event's reserved `[Q]` slots and
 * owe nothing.
 *
 * Currently the three upper senior tiers (`major`, our Grand Slam
 * equivalent, plus `tour` and `challenger` — the ladder's middle rungs
 * get the mechanic too, so "earn your way into a bigger event" isn't
 * only a top-of-the-game experience). `futures` deliberately never
 * holds qualifying: it is the freely-enterable bottom rung, the route
 * in. A set, not a literal, for the same reason
 * `OBLIGATORY_TIER_SET` is one — which tiers qualify is a balance
 * decision, and it deliberately is NOT the same set as the obligatory
 * one: an event can run qualifying without being mandatory to enter
 * (real ATP 500s do exactly that). No junior tier holds qualifying —
 * the ITF junior circuit's entry system isn't modelled here at all.
 *
 * PLACEHOLDER membership, owned by the ranking-realism balance pass.
 */
const QUALIFYING_TIER_SET: ReadonlySet<TournamentTier> = new Set<TournamentTier>(['major', 'tour', 'challenger']);

export function hasQualifying(tier: TournamentTier): boolean {
  return QUALIFYING_TIER_SET.has(tier);
}

/**
 * Fraction of a qualifying event's main draw reserved for `[Q]`
 * entrants. Real Slams take 16 qualifiers into a 128 draw (1/8), which
 * is where this comes from; applying the same fraction to smaller draws
 * keeps a 32-draw at 4 and a 16-draw at 2 — always at least 2, never a
 * fraction, since draw sizes are powers of two from 16 up.
 *
 * PLACEHOLDER, same tuning pass as QUALIFYING_TIER_SET above.
 */
export const QUALIFIER_SLOT_FRACTION = 1 / 8;

/** How many of this tournament's main-draw places are reserved for
 * qualifiers — 0 for every tier that holds no qualifying, in which case
 * every entrant is a direct acceptance and this whole rule is inert. */
export function qualifierSlotsFor(tier: TournamentTier, drawSize: DrawSize): number {
  if (!hasQualifying(tier)) return 0;
  return Math.floor(drawSize * QUALIFIER_SLOT_FRACTION);
}

export interface EntryTypeDecision {
  /** 'accepted' with the entry type the draw sheet should print, or
   * 'qualifying-full' when a below-cutoff player tried to take a `[Q]`
   * slot after all of them were already taken — a real refusal (they
   * did not come through qualifying), not a silent downgrade to direct
   * acceptance, which would hand them the place the cutoff exists to
   * withhold. */
  kind: 'accepted' | 'qualifying-full';
  entryType: EntryType;
  qualifierSlots: number;
}

export interface EntryTypeInput {
  tier: TournamentTier;
  drawSize: DrawSize;
  /** The registrant's CURRENT rank in the tournament's own ranking band
   * (1-indexed; null = unranked). Same deliberate "current rank, not
   * rank at the entry deadline" simplification the obligatory rule
   * makes — see DIRECT_ACCEPTANCE_CUTOFF's doc comment. */
  rank: number | null;
  /** How many `[Q]` places this tournament's existing entrants already
   * occupy. Under the full model that means "how many are already in
   * the qualifying field", not "how many have already won a main-draw
   * slot" (nobody has, at registration time). */
  qualifierSlotsTaken: number;
  /** The tournament's OWN stored reserved-slot count, when it has one.
   * Optional: omitted, the count is derived from tier/draw size. A live
   * tournament always passes its stored value, so a later change to
   * QUALIFIER_SLOT_FRACTION can never resize an event already in
   * progress. */
  qualifierSlots?: number;
  /** How many registrants the QUALIFYING FIELD holds — several players
   * per reserved slot, since they have to play each other for it (the
   * full model). Optional: omitted, it falls back to the reserved-slot
   * count, which is precisely the light model's "one `[Q]` registrant
   * per slot, assumed to have come through" behaviour, so every
   * pre-full-model caller and test is unchanged. */
  qualifyingCapacity?: number;
}

/**
 * Decides what an incoming registrant's `EntryType` is — the whole of
 * the light `[Q]` model's rule, as one pure, total function so the
 * cutoff's two consequences (obligation above it, qualifying below it)
 * are visibly derived from the SAME predicate
 * (`isEligibleForDirectAcceptance`) rather than two drifting copies of
 * a threshold.
 *
 * A tier with no qualifying accepts everyone as `'DA'` — the ladder's
 * lower rungs must stay freely enterable, that's what makes them the
 * route up. At a qualifying tier, an above-cutoff player is `'DA'` and
 * a below-cutoff/unranked one is `'Q'`: under the FULL model that means
 * they enter the QUALIFYING draw and must actually win their way
 * through it, and they are refused outright once that field is full.
 * (`resolveEntryType` itself is at the bottom of the file, beside the
 * constants below that it reads.)
 */

/**
 * How many players contest EACH reserved `[Q]` slot — i.e. the size of
 * the mini-bracket one qualifier wins. The qualifying field is
 * therefore `qualifierSlots x playersPerSlot`, and it is played for
 * `log2(playersPerSlot)` rounds (NOT down to a single winner: the
 * qualifying bracket deliberately STOPS once exactly `qualifierSlots`
 * players remain, which is precisely what a real qualifying draw does).
 *
 * Varies by tier because the user's own framing was that qualifying
 * depth should depend on the circuit and category: a Slam-equivalent
 * runs the deepest qualifying (8 per slot = 3 rounds, i.e. a 128-player
 * field for 16 places, the real ratio), the two tiers below it run a
 * shorter 4-per-slot (2 rounds) event.
 *
 * **Never below 4** (and always a power of two): a 2-per-slot field
 * would make qualifying exactly ONE round, and a single-round bracket's
 * winners can include bye recipients who have no match row at all (see
 * BracketGenerator.generate) — reading "who came through" would then
 * need the bye reconstruction only BracketGenerator can do. Requiring
 * at least two rounds means every qualifier has a real recorded win in
 * the final qualifying round, so `Tournament.qualifyingWinners()` stays
 * a straight read of that round's outcomes. A real structural
 * constraint, not a balance preference — asserted in the tests.
 *
 * PLACEHOLDER values, same tuning pass as QUALIFYING_TIER_SET.
 */
const QUALIFYING_PLAYERS_PER_SLOT: Readonly<Partial<Record<TournamentTier, number>>> = {
  major: 8,
  tour: 4,
  challenger: 4,
};

/** Players contesting each reserved slot — 0 at a tier with no
 * qualifying. */
export function qualifyingPlayersPerSlot(tier: TournamentTier): number {
  return hasQualifying(tier) ? (QUALIFYING_PLAYERS_PER_SLOT[tier] ?? 0) : 0;
}

/** Total size of the qualifying field — 0 when this tournament holds no
 * qualifying at all, in which case there is no second bracket and the
 * whole feature is inert for it. */
export function qualifyingDrawSizeFor(tier: TournamentTier, drawSize: DrawSize): number {
  return qualifierSlotsFor(tier, drawSize) * qualifyingPlayersPerSlot(tier);
}

/** How many rounds the qualifying bracket plays before exactly
 * `qualifierSlots` players are left — log2 of the field-per-slot, so 3
 * for a major and 2 for tour/challenger. 0 = no qualifying. */
export function qualifyingRoundCountFor(tier: TournamentTier, drawSize: DrawSize): number {
  const perSlot = qualifyingPlayersPerSlot(tier);
  if (perSlot === 0 || qualifierSlotsFor(tier, drawSize) === 0) return 0;
  return Math.log2(perSlot);
}

/**
 * Ranking points for being eliminated in qualifying, indexed by
 * qualifying rounds WON. Deliberately tiny — reaching the last
 * qualifying round is a real result worth something, but it must never
 * approach a main-draw result at the same event.
 *
 * Index 0 is 0 at every tier, for exactly the same reason
 * StandardRankingPointsTable's index 0 is: a ranking is earned by
 * actually winning a match, never granted for turning up.
 *
 * A player who comes THROUGH qualifying is never awarded from this
 * table at all — they weren't eliminated here; they go on to earn
 * ordinary main-draw points. That's what keeps the invariant that a
 * player has at most ONE ranking-ledger entry per tournament, whichever
 * draw they exited from (see ApplyObligatoryTournamentZerosUseCase,
 * whose "played" set is read straight off the ledger).
 *
 * PLACEHOLDER values, same tuning pass as the rest of this file.
 */
const QUALIFYING_POINTS: Readonly<Partial<Record<TournamentTier, ReadonlyArray<number>>>> = {
  //          qualifying rounds won: 0  1   2
  major: [0, 10, 25],
  tour: [0, 3, 8],
  challenger: [0, 1, 3],
};

export function qualifyingPointsFor(tier: TournamentTier, qualifyingRoundsWon: number): number {
  const table = QUALIFYING_POINTS[tier];
  if (!table) return 0;
  return table[Math.min(qualifyingRoundsWon, table.length - 1)] ?? 0;
}

export function resolveEntryType(input: EntryTypeInput): EntryTypeDecision {
  const qualifierSlots = input.qualifierSlots ?? qualifierSlotsFor(input.tier, input.drawSize);
  if (qualifierSlots === 0 || isEligibleForDirectAcceptance(input.rank)) {
    return { kind: 'accepted', entryType: 'DA', qualifierSlots };
  }
  const qualifyingCapacity = input.qualifyingCapacity ?? qualifierSlots;
  if (input.qualifierSlotsTaken >= qualifyingCapacity) {
    return { kind: 'qualifying-full', entryType: 'Q', qualifierSlots };
  }
  return { kind: 'accepted', entryType: 'Q', qualifierSlots };
}
