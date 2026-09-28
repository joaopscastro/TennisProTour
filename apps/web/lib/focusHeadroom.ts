import type { PotentialProjectionDto, TrainingFocus } from './api';

/**
 * The "dead training focus" read — the frontend half of the
 * physical-projection fix (Batch 3, item 3.2).
 *
 * A physical attribute has a real, hidden per-attribute training ceiling
 * (`physicalCeilings`), and the scout's projection for a physical
 * attribute is now fuzzed one-sided downward so it can never exceed that
 * ceiling (see PotentialProjectionService). That means a maxed
 * attribute always reads `projected === current` and draws no ghost bar
 * — but nothing told the manager who had SET that attribute as their
 * training focus. A live case spent ~2,200 XP over 18 weeks training a
 * speed attribute sitting at its ceiling, moving nothing.
 *
 * This helper answers, purely from fields the profile already exposes
 * (`current`/`projected` on the projection — no hidden ceiling number is
 * ever read, serialized, or passed through here): does this week's
 * resolved focus land on a physical attribute whose projection shows no
 * remaining headroom? If so, the profile renders the note below.
 */

const PHYSICAL_ATTRIBUTES: ReadonlySet<string> = new Set(['speed', 'stamina', 'strength']);

export const DEAD_PHYSICAL_FOCUS_NOTE =
  "The scout's read shows no remaining physical headroom here — training this may not move it.";

/**
 * Returns the plain-language warning when `focus` is a single physical
 * attribute whose projection promises no headroom (`projected` at or
 * below `current`), or null in every other case: no focus, a surface
 * focus, a technical attribute (no hard cap exists, so its projection is
 * never "dead"), an attribute missing from the projection, or one with
 * real projected headroom. `potential` may be null/undefined while the
 * profile is still loading — an unknown projection never warns.
 */
export function deadPhysicalFocusWarning(
  focus: TrainingFocus | null | undefined,
  potential: PotentialProjectionDto | null | undefined,
): string | null {
  if (!focus || focus.kind !== 'attribute') return null;
  if (!PHYSICAL_ATTRIBUTES.has(focus.attribute)) return null;
  const projection = potential?.attributes.physical[focus.attribute];
  if (!projection) return null;
  if (projection.projected > projection.current) return null;
  return DEAD_PHYSICAL_FOCUS_NOTE;
}
