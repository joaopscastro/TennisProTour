import { PlayerAttributes, Surface, TechnicalAttribute, PhysicalAttribute } from '../player/PlayerAttributes';

/**
 * Surface × attribute weighting for match simulation (`docs/training-
 * redesign-per-attribute.md`'s "Surface × attribute weighting" section —
 * previously designed but never wired into `StatisticalMatchSimulator`).
 * Makes WHICH attribute a manager trained interact with WHICH surface a
 * match is played on: a grass serve-and-volleyer and a clay grinder
 * become mechanically distinct builds, not just cosmetically different
 * ones sharing the same flat averages.
 *
 * Deliberately separate from `SurfaceAffinities` (the passive per-player
 * "how well do they play on this surface" stat already applied as
 * `surfaceBonus` in `effectiveRating`) — these are two different
 * mechanisms. This one re-weights the RAW attribute values themselves
 * before they're averaged; it never touches the affinity stat or its
 * bonus term.
 *
 * Every multiplier here is an explicit PLACEHOLDER, same status as every
 * other flagged constant in this codebase (fatigue/form thresholds,
 * HOME_ADVANTAGE_BONUS, aging thresholds, ranking-point values) — grounded
 * in how tennis actually plays (grass rewards serve-and-volley, clay
 * rewards grinding stamina/consistency), not yet balance-tuned against
 * real simulation data. That tuning pass is a separate, larger effort
 * (see CLAUDE.md's "Immediate next steps" item 3).
 */
export type WeightableAttribute = TechnicalAttribute | PhysicalAttribute | 'consistency' | 'clutch';

const SURFACE_ATTRIBUTE_WEIGHTS: Readonly<Record<Surface, Partial<Record<WeightableAttribute, number>>>> = {
  grass: { serve: 1.5, volley: 1.4, speed: 1.1, stamina: 0.8, consistency: 0.9 },
  clay: { stamina: 1.4, consistency: 1.3, forehand: 1.2, serve: 0.8, volley: 0.7 },
  hard: {},
  indoor: { serve: 1.3, volley: 1.1, stamina: 0.9 },
};

/** Any attribute not explicitly listed for a surface (e.g. backhand,
 * strength, and clutch on every surface today) is neutral — ×1.0. */
export function surfaceAttributeWeight(surface: Surface, attribute: WeightableAttribute): number {
  return SURFACE_ATTRIBUTE_WEIGHTS[surface][attribute] ?? 1.0;
}

/** Weighted mean (not a plain sum) so the result stays on the same 0-100
 * scale a flat average would have produced — a build that leans into
 * surface-rewarded attributes pulls the average up, one that leans into
 * penalized attributes pulls it down, but the scale `effectiveRating`'s
 * other terms (fatigue penalty, form modifier) were tuned against never
 * shifts underneath them. */
function weightedMean(entries: ReadonlyArray<readonly [WeightableAttribute, number]>, surface: Surface): number {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [attribute, value] of entries) {
    const weight = surfaceAttributeWeight(surface, attribute);
    weightedSum += value * weight;
    weightTotal += weight;
  }
  return weightTotal === 0 ? 0 : weightedSum / weightTotal;
}

/** Replaces the flat technical mean in `effectiveRating` with a
 * surface-weighted one. */
export function weightedTechnicalAverage(attributes: PlayerAttributes, surface: Surface): number {
  const { technical } = attributes;
  return weightedMean(
    [
      ['serve', technical.serve.value],
      ['forehand', technical.forehand.value],
      ['backhand', technical.backhand.value],
      ['volley', technical.volley.value],
    ],
    surface,
  );
}

/** Replaces the flat physical mean in `effectiveRating` with a
 * surface-weighted one. */
export function weightedPhysicalAverage(attributes: PlayerAttributes, surface: Surface): number {
  const { physical } = attributes;
  return weightedMean(
    [
      ['speed', physical.speed.value],
      ['stamina', physical.stamina.value],
      ['strength', physical.strength.value],
    ],
    surface,
  );
}

/** Replaces the flat mental mean in `effectiveRating` with a
 * surface-weighted one — only `consistency` is ever surface-weighted
 * (clay rewards it, grass penalizes it slightly); `clutch` stays neutral
 * on every surface today. */
export function weightedMentalAverage(attributes: PlayerAttributes, surface: Surface): number {
  const { mental } = attributes;
  return weightedMean(
    [
      ['consistency', mental.consistency.value],
      ['clutch', mental.clutch.value],
    ],
    surface,
  );
}
