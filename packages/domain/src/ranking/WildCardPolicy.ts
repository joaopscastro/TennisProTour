import { PlayerId } from '../shared/ids';
import { TournamentTier } from '../competition/CompetitionTypes';
import { hasQualifying } from './QualifyingPolicy';

/**
 * Wild cards (Chapter 7 §7.12 of the 2026 ATP rulebook) — a main-draw
 * place awarded independent of ranking. Real wild cards are a
 * committee's discretionary pick; this game has no committee, so the
 * mechanic is instead a real ALGORITHM, decided automatically at draw-
 * formation time, BEFORE the qualifying draw is even seeded: any
 * registered QUALIFYING entrant (i.e. below the direct-acceptance
 * cutoff) whose nationality matches the tournament's `hostCountry` is a
 * candidate, and the best-ranked candidates (up to the tier's slot
 * count) are pulled straight into the main draw instead of having to
 * play their way through qualifying — the real-world "the home nation
 * gives its own promising-but-not-yet-ranked players a break" pattern.
 * See `selectWildCards` below for the actual selection, and
 * `applyWildCards` (packages/application/src/use-cases) for where it's
 * wired into draw formation. There is no manager action here at all —
 * unlike the qualifying/direct-acceptance split, a manager never
 * requests or opts into a wild card; it's either awarded by the
 * algorithm or it isn't.
 *
 * Gated on `hasQualifying(tier)` — deliberately the SAME tier set
 * QualifyingPolicy uses, not a separately-curated one: a wild card only
 * means something as an alternative to playing qualifying, so a tier
 * with no qualifying (`futures`, every junior grade) has nothing for a
 * wild card to rescue anyone from and awards none.
 *
 * `WILD_CARD_SLOTS_BY_TIER` values are explicit PLACEHOLDER counts, not
 * sourced or tuned — real tournaments vary the number of wild cards
 * they award; these are small, round numbers chosen only to keep the
 * mechanic scarce (a wild card should feel like a real break, not a
 * routine entry method).
 */
const WILD_CARD_SLOTS_BY_TIER: Readonly<Partial<Record<TournamentTier, number>>> = {
  major: 2,
  tour: 2,
  challenger: 1,
};

export function wildCardSlotsFor(tier: TournamentTier): number {
  if (!hasQualifying(tier)) return 0;
  return WILD_CARD_SLOTS_BY_TIER[tier] ?? 0;
}

/** One registered qualifying entrant's data as the wild card algorithm
 * needs it — gathered by the application layer (which alone knows how
 * to look up a Player's nationality and live rank) and handed to the
 * pure `selectWildCards` below. `rank` is this player's CURRENT
 * position in the tournament's ranking band; `null` = unranked (never
 * preferred over a ranked candidate). */
export interface WildCardCandidate {
  readonly playerId: PlayerId;
  readonly nationality: string;
  readonly rank: number | null;
}

/**
 * The wild card algorithm itself — pure, deterministic, no I/O. Filters
 * `candidates` to those sharing `hostCountry` (no host country recorded
 * = no wild cards, same as the home-advantage sim bonus's own "null
 * means nobody is home" rule), ranks them best-first (unranked
 * candidates last, broken by playerId for full determinism — the same
 * "never a hidden skill proxy" discipline StartDueTournamentsUseCase's
 * filler ordering already follows), and takes the top `slots`.
 *
 * Deliberately prefers the BEST-ranked locals, not a random or oldest-
 * registered pick: a wild card is a genuine break for a promising local
 * who just missed the cutoff, not a lottery.
 */
export function selectWildCards(
  candidates: ReadonlyArray<WildCardCandidate>,
  hostCountry: string | null,
  slots: number,
): PlayerId[] {
  if (!hostCountry || slots <= 0) return [];
  const local = candidates.filter((c) => c.nationality === hostCountry);
  local.sort((a, b) => {
    if (a.rank === null && b.rank === null) return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  });
  return local.slice(0, slots).map((c) => c.playerId);
}
