import { ManagerId, Player } from '@tennis-manager/domain';
import { BillingPort } from '../ports/ports';

/** Free-tier roster cap (Rocking Rackets' base 2-player scarcity). */
export const FREE_ROSTER_CAP = 2;
/** Manager Pro roster cap. The extra capacity is NOT a flat unlock:
 * per CLAUDE.md principle #1 it's paired with faster stat decay for
 * Pro-managed players (see AdvanceWorldWeekUseCase's accelerated
 * aging path). */
export const PRO_ROSTER_CAP = 4;

/** Shared by every use case that adds a player to a manager's roster
 * (claiming from the talent pool, creating a custom player) — kept in
 * one place so the cap logic can't drift between them. */
export async function maxRosterSizeFor(managerId: ManagerId, billing: BillingPort): Promise<number> {
  return (await billing.isProSubscriber(managerId)) ? PRO_ROSTER_CAP : FREE_ROSTER_CAP;
}

/**
 * How many LIVE roster slots a manager's players actually occupy.
 *
 * Retirement deliberately RETAINS `manager_id` (history/lineage — see
 * Player.isRetired), but a retired player can no longer be entered,
 * trained or developed, so it must never consume a roster slot: without
 * this exclusion a manager whose roster is all retired is permanently at
 * cap and can never sign a replacement. Real, soak-run-confirmed bug: two
 * managers sat at 2/2 (both retired members) and were refused a
 * replacement claim 271 times.
 *
 * The roster dashboard deliberately still LISTS retired players (they
 * should be visible) — only the capacity count excludes them.
 */
export function activeRosterCount(players: readonly Player[]): number {
  return players.filter((player) => !player.isRetired()).length;
}

