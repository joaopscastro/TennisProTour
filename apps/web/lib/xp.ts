/**
 * Manager-XP affordability, pure so the false-"0 XP" race is testable and
 * can't regress.
 *
 * The bug: the Scouting screen derived `xpBalance = entitlement?.xpBalance
 * ?? 0`. While the entitlement request was in flight (or slow) that read
 * as a real balance of 0 — the body showed "YOUR XP 0", every Sign button
 * was disabled, and each card said "Need N more", even though the sidebar
 * (which only renders once the value is available) showed the true
 * balance. "Not loaded yet" and "0 XP" must never collapse into the same
 * value.
 */
export type Affordability =
  | { state: 'unknown' }
  | { state: 'affordable' }
  | { state: 'short'; remaining: number };

/** `balance` is `null`/`undefined` until the entitlement has loaded. */
export function xpAffordability(balance: number | null | undefined, cost: number): Affordability {
  if (balance === null || balance === undefined) return { state: 'unknown' };
  if (balance >= cost) return { state: 'affordable' };
  return { state: 'short', remaining: cost - balance };
}
