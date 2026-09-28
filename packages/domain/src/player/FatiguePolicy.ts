/**
 * How much fatigue one completed match inflicts.
 *
 * Rocking Rackets models this with a dedicated `endurance` stat that is
 * distinct from in-match strength (docs/rocking-rackets-competitive-analysis.md
 * §1a/§2). We deliberately do NOT add a new first-class attribute here:
 * per CLAUDE.md's "avoid over-engineering / avoid systems for their own
 * sake" discipline, a brand-new attribute would ripple through
 * PlayerAttributes, generation, physical ceilings, aging, every DTO and
 * the DB schema. Instead we fold fatigue-resistance into the EXISTING
 * `stamina` physical attribute — a high-stamina player tires less. This
 * is an honest, disclosed simplification (RR keeps them separate to
 * avoid double-counting; we accept the mild double-count of stamina
 * both helping in-match and reducing fatigue, because "the fit player
 * also recovers better" is intuitive and it keeps the attribute set
 * from growing). Revisit and split out a real `endurance` stat only if
 * a specific balance reason appears.
 *
 * ALL constants here are illustrative placeholders, flagged the same
 * way aging thresholds and ranking point values are — the fatigue/form
 * tuning pass (docs/rocking-rackets-competitive-analysis.md §5, the
 * main open balance question) owns their real values.
 */

/** Fatigue a match costs a player with zero stamina resistance. */
export const BASE_MATCH_FATIGUE = 8;

/** Maximum fraction of the base cost that stamina can shave off. At
 * stamina 100 a player pays BASE * (1 - this); at stamina 0, the full
 * base. */
export const MAX_STAMINA_FATIGUE_RESISTANCE = 0.4;

/**
 * Fatigue (0–100 scale) inflicted by one match on a player with the
 * given stamina (0–100). Higher stamina → less fatigue, down to a floor
 * of BASE_MATCH_FATIGUE * (1 - MAX_STAMINA_FATIGUE_RESISTANCE). Rounded
 * to a whole point (fatigue is stored as an integer).
 *
 * `base` overrides BASE_MATCH_FATIGUE for one call — the same
 * compare-candidates-against-real-data seam `fatigueRecoveredPerDay`'s
 * own `base` parameter gives the balance tool. Production callers pass
 * nothing, so they always get the constant above.
 */
export function fatigueCostForMatch(stamina: number, base: number = BASE_MATCH_FATIGUE): number {
  const clampedStamina = Math.max(0, Math.min(100, stamina));
  const resistance = (clampedStamina / 100) * MAX_STAMINA_FATIGUE_RESISTANCE;
  return Math.round(base * (1 - resistance));
}

// ---------------------------------------------------------------------------
// Daily recovery — the "rest" half of the fatigue system (applied on EVERY
// advanced day, mid-week and on the weekly rollover alike; see
// AdvanceWorldWeekUseCase). All constants PLACEHOLDER, same tuning-pass
// status as BASE_MATCH_FATIGUE above.
// ---------------------------------------------------------------------------

/** Flat fatigue recovered over one advanced day — the base term. */
export const FATIGUE_RECOVERY_PER_DAY = 3;

/**
 * Fraction of a player's CURRENT fatigue additionally recovered per
 * advanced day. This is what turns recovery from a FIXED drain the
 * overplayed player eventually outruns (a ratchet, where any schedule
 * deep enough to out-accrue it pins fatigue at 100 forever) into a
 * SELF-LIMITING force: the more tired the player is, the faster they
 * recover, so accrual and recovery meet at an equilibrium instead of a
 * ceiling.
 *
 * Quantified (continuous math; the balance tool reports the real
 * integer-stepped values): a senior's 32-draw title run (5 matches/week
 * × ~6 fatigue) settles around fatigue 15-20, a 9-11-match elite week
 * (singles + doubles deep runs) oscillates around 47-66 (mid-week peaks
 * 55-76), a 128-draw major title run (7 matches) around 26, and ordinary
 * play (≤3 matches/week) stays at 0.
 *
 * Retuned 0.05 → 0.08 (docs/balance-tuning-report.md's third fatigue/
 * form pass) because a measured 52-week agent season showed the previous
 * value was calibrated against a match volume that no longer exists:
 * Batch 4B added a second weekly `tour` event, so a realistic elite
 * weekly load is ~9-14 matches (singles + doubles), and at 0.05 those
 * schedules sat at fatigue ≥80 for 38 of 52 weeks — including 9
 * consecutive weeks ≥90 — making singles deep runs coin-flips. At 0.08
 * the same schedules oscillate in the intended 40-80 band while a rest
 * week still visibly recovers (an 11-match week's ~66 drops to ~22 in an
 * idle week), so the fatigue penalty still forces real rest/taper
 * decisions. STILL AN EXPLICIT PLACEHOLDER, same as every constant here.
 *
 * Deliberately retuned as a PAIR with FORM_STALE_THRESHOLD /
 * FORM_OUT_OF_BAND_PENALTY_PER_POINT in StatisticalMatchSimulator:
 * fatigue now carries the overplay cost, form stays the rust/rhythm
 * signal (see docs/balance-tuning-report.md's second fatigue/form pass).
 */
export const FATIGUE_RECOVERY_FRACTION = 0.08;

/**
 * Fatigue recovered over ONE advanced day by a player currently at
 * `fatigue`: the flat `base` (FATIGUE_RECOVERY_PER_DAY in production;
 * callers may pass an override, e.g. the balance tool's candidate
 * comparison) PLUS `fraction` × current fatigue (FATIGUE_RECOVERY_FRACTION
 * in production; the same override seam), rounded to a whole point so
 * the stored integer never gains a fraction.
 *
 * This is the ONE place the recovery formula lives — `Player.recoverFatigue`
 * applies it, and `DrizzlePlayerRepository.recoverFatigueForAll` mirrors
 * the exact same arithmetic in one SQL statement (the daily fast path).
 * The two must never diverge; `DrizzleRepositories.integration.test.ts`
 * pins that against real Postgres.
 */
export function fatigueRecoveredPerDay(
  fatigue: number,
  base: number = FATIGUE_RECOVERY_PER_DAY,
  fraction: number = FATIGUE_RECOVERY_FRACTION,
): number {
  const clampedFatigue = Math.max(0, Math.min(100, fatigue));
  return Math.round(base + clampedFatigue * fraction);
}
