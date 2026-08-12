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
 */
export function fatigueCostForMatch(stamina: number): number {
  const clampedStamina = Math.max(0, Math.min(100, stamina));
  const resistance = (clampedStamina / 100) * MAX_STAMINA_FATIGUE_RESISTANCE;
  return Math.round(BASE_MATCH_FATIGUE * (1 - resistance));
}
