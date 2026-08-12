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
 * Currently the two biggest senior tiers (`major`, our Grand Slam
 * equivalent, and `tour`). A set, not a literal, for the same reason
 * `OBLIGATORY_TIER_SET` is one — which tiers qualify is a balance
 * decision, and it deliberately is NOT the same set as the obligatory
 * one: an event can run qualifying without being mandatory to enter
 * (real ATP 500s do exactly that). No junior tier holds qualifying —
 * the ITF junior circuit's entry system isn't modelled here at all.
 *
 * PLACEHOLDER membership, owned by the ranking-realism balance pass.
 */
const QUALIFYING_TIER_SET: ReadonlySet<TournamentTier> = new Set<TournamentTier>(['major', 'tour']);

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
  /** How many `[Q]` slots this tournament's existing entrants already
   * occupy. */
  qualifierSlotsTaken: number;
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
 * a below-cutoff/unranked one is `'Q'` while reserved slots remain.
 */
export function resolveEntryType(input: EntryTypeInput): EntryTypeDecision {
  const qualifierSlots = qualifierSlotsFor(input.tier, input.drawSize);
  if (qualifierSlots === 0 || isEligibleForDirectAcceptance(input.rank)) {
    return { kind: 'accepted', entryType: 'DA', qualifierSlots };
  }
  if (input.qualifierSlotsTaken >= qualifierSlots) {
    return { kind: 'qualifying-full', entryType: 'Q', qualifierSlots };
  }
  return { kind: 'accepted', entryType: 'Q', qualifierSlots };
}
