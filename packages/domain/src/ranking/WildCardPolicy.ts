import { TournamentTier } from '../competition/CompetitionTypes';

/**
 * Wild cards (Chapter 7 §7.12 of the 2026 ATP rulebook) — a main-draw
 * place awarded entirely at the TOURNAMENT's discretion, independent of
 * ranking. In real tennis this is genuinely a third path into a draw,
 * distinct from both direct acceptance (earned by rank) and qualifying
 * (earned by winning through): a wild card bypasses the ranking cutoff
 * outright. `EntryType`'s `'WC'` value has existed structurally since
 * the qualifying-model work, unused — this is what finally awards one.
 *
 * **Deliberately simplified from the real rule**, same "ship the core
 * mechanic, disclose what's not modeled" discipline as
 * QualifyingPolicy/ObligatoryTournamentPolicy:
 * - No committee/NPC discretion exists in this game, so a wild card is
 *   simply a manager-requested registration that bypasses the cutoff —
 *   there's no "the tournament chooses who gets it" layer to build.
 * - The real per-player ANNUAL limit (5 main-draw singles wild cards a
 *   year, §7.12.B.1) is NOT enforced — tracking it would need a new
 *   season-wide, cross-tournament query this feature's scope doesn't
 *   otherwise need. The only real constraint modeled is the
 *   per-TOURNAMENT slot cap below (finite either way — a manager can't
 *   wild-card an unlimited roster into one event).
 * - Junior tiers award none — same senior-tour-only scoping the real
 *   wild card rule effectively has in this game's context (there is no
 *   junior wild card concept anywhere else in this codebase either).
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
  futures: 1,
};

export function wildCardSlotsFor(tier: TournamentTier): number {
  return WILD_CARD_SLOTS_BY_TIER[tier] ?? 0;
}
