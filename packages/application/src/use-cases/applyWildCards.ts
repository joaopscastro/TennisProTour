import { selectWildCards, Tournament, WildCardCandidate, wildCardSlotsFor } from '@tennis-manager/domain';
import { PlayerRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';

/**
 * Applies the automatic wild card algorithm (see WildCardPolicy) to a
 * tournament's currently-registered QUALIFYING entrants, mutating
 * `tournament` in place via Tournament.grantWildCard for whoever is
 * selected. Shared by the two places a tournament's qualifying (or
 * main, at a tier with none) draw gets formed —
 * RegisterEntrantUseCase's auto-start-on-full-registration path and
 * StartDueTournamentsUseCase's weekly force-start sweep — so the rule
 * applies no matter which path actually closes registration.
 *
 * MUST be called before the qualifying bracket is seeded: a wild card
 * bypasses qualifying entirely rather than winning a place in it (see
 * Tournament.grantWildCard, which refuses once the qualifying draw has
 * started).
 *
 * A no-op (0) when the tier awards no wild cards (`wildCardSlotsFor`),
 * the tournament has no recorded `hostCountry`, or no registered
 * qualifying entrant shares that country — the selection itself is the
 * pure `selectWildCards`; this function's only job is gathering each
 * candidate's nationality and live rank (application-layer concerns
 * WildCardPolicy has no access to) and applying whatever it returns.
 *
 * Returns how many wild cards were actually granted.
 */
export async function applyWildCards(
  tournament: Tournament,
  players: PlayerRepository,
  /** The SENIOR rank query — wild cards only ever apply to senior
   * tiers (every tier that holds qualifying is senior-only; see
   * QualifyingPolicy). Optional for the same test-compat reason
   * RegisterEntrantUseCase's own seniorRankPosition is: omitted, every
   * candidate is treated as unranked (still eligible, just tie-broken
   * by playerId — the rule stays correct, just less merit-ordered). */
  seniorRankPosition?: RankPositionQuery,
): Promise<number> {
  const slots = wildCardSlotsFor(tournament.tier);
  if (slots === 0 || !tournament.hostCountry) return 0;

  const candidates: WildCardCandidate[] = [];
  for (const entrant of tournament.qualifyingEntrants) {
    const player = await players.findById(entrant.playerId);
    if (!player) continue;
    const rank = seniorRankPosition ? (await seniorRankPosition.rankFor(entrant.playerId)).rank : null;
    candidates.push({ playerId: entrant.playerId, nationality: player.nationality, rank });
  }
  if (candidates.length === 0) return 0;

  const selected = selectWildCards(candidates, tournament.hostCountry, slots);
  for (const playerId of selected) {
    tournament.grantWildCard(playerId);
  }
  return selected.length;
}
