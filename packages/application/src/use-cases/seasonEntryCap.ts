import { PlayerId, Tournament } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';

/**
 * The per-season entry count behind the challenger soft cap (Batch 4B,
 * F1 — see TierEntryRestrictionPolicy), as both registration use cases
 * and the player-scoped preview must read it.
 *
 * `TournamentRepository.countTierEntriesForSeason` counts DISTINCT
 * tournaments at the tier in the season where the player holds a singles
 * OR doubles entry. Like the weekly cap, the tournament being registered
 * must be EXCLUDED from its own count (one tournament counts once, so
 * adding doubles to an event the player already holds singles in must
 * not consume a second season slot) — done here from the loaded
 * aggregate's own public accessor rather than with an extra SQL
 * parameter, so the single shared helper can never drift between the
 * two use cases.
 *
 * When the repository method is absent (the in-memory unit-test fakes),
 * the count reads 0 and the cap is simply inert — the same deliberate
 * degradation every optional collaborator in this codebase has. The
 * composition root always passes the real Drizzle adapter.
 */
export async function seasonTierEntryCountFor(
  tournaments: TournamentRepository,
  tournament: Tournament,
  playerId: PlayerId,
): Promise<number> {
  const total =
    (await tournaments.countTierEntriesForSeason?.(playerId, tournament.tier, tournament.weekScheduled.season)) ?? 0;
  return tournament.isPlayerEntered(playerId) ? total - 1 : total;
}
