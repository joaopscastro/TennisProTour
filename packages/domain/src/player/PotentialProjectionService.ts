import { PlayerAttributes, PhysicalAttribute, TechnicalAttribute } from './PlayerAttributes';
import { PhysicalCeilings, PotentialTier, ageInterpolationFactor, tierForPotentialCeiling } from './PlayerGenerationPolicy';

/**
 * P5 — the "scout's projection" read (docs/rocking-rackets-competitive-analysis.md §3).
 *
 * Turns a player's HIDDEN truths (`potentialCeiling`, `physicalCeilings`,
 * `talent`) into a legible-but-deliberately-imperfect, PROFILE-ONLY read
 * on their upside: a headline projected-ceiling BAND, per-attribute
 * "ghost cap" projections, an RR-style development %, and a confidence
 * that NARROWS as the player ages. It is the counterpart to
 * StandardPlayerGenerationPolicy's already-baked scouting noise, but for
 * the profile page rather than the pool list.
 *
 * Three properties are load-bearing and must not regress:
 *   1. DERIVED, never stored. Nothing here is persisted — the whole
 *      projection is recomputed from the hidden fields on every read, so
 *      no new column exists and (crucially) the raw ceiling numbers are
 *      never serialized (§3 point 1; CLAUDE.md's non-exposure rule). The
 *      caller (DrizzlePlayerProfileQuery) maps ONLY this service's output
 *      into the DTO, never the raw `potentialCeiling`/`physicalCeilings`.
 *   2. DETERMINISTIC and UNGAMEABLE. The per-player fuzz comes from a
 *      stable hash of the playerId, NOT a fresh random each request — so
 *      refetching a profile can never re-roll a luckier read. The same
 *      player always shows the same projection at the same age.
 *   3. TIGHTENS toward TRUTH with age. The band half-width and the
 *      per-player bias both shrink to zero as the player ages from
 *      PROJECTION_YOUNG_AGE_WEEKS to PROJECTION_MATURE_AGE_WEEKS (reusing
 *      the shared ageInterpolationFactor curve), so a young signing is a
 *      genuine gamble whose uncertainty RESOLVES to the true ceiling as
 *      they mature — the emotional payoff §3 option C is built around.
 *      "Ages and plays" collapses to one axis here on purpose: a player
 *      only ages by surviving weekly ticks, which only happen as the
 *      world (and their matches) progress, so age IS the play-time proxy.
 *
 * All the numeric constants below are PLACEHOLDER game-balance values,
 * flagged the same way aging thresholds / ranking points / development
 * constants are — safe to tune, not architectural.
 */

/** Youngest age the projection treats as "maximally uncertain" — the
 * youngest a talent-pool candidate is generated at (14yo, see
 * TALENT_POOL_AGE_RANGE). At/below this the band is at full width. */
export const PROJECTION_YOUNG_AGE_WEEKS = 14 * 52;
/** Age at/after which the scout is treated as fully confident: the band
 * collapses to a point ON the true ceiling and the bias vanishes. ~24yo
 * is comfortably into a normal prime, by which point a real scout has
 * seen enough. PLACEHOLDER. */
export const PROJECTION_MATURE_AGE_WEEKS = 24 * 52;
/** Half-width of the projected-ceiling band (skill points) at the
 * youngest age; scales linearly to 0 at PROJECTION_MATURE_AGE_WEEKS.
 * PLACEHOLDER. */
export const PROJECTION_MAX_HALF_WIDTH = 9;
/** How much of the current half-width the stable per-player bias may
 * shift the point estimate AWAY from the true ceiling (so the midpoint
 * isn't a trivially-readable "truth ± symmetric noise"). At 0.6 a young
 * player's headline mid can sit meaningfully above or below their real
 * ceiling; as half-width shrinks with age, so does this offset, until
 * the mid lands exactly on truth. PLACEHOLDER. */
export const PROJECTION_BIAS_FRACTION = 0.6;
/** Confidence at/above which the projection is considered "resolved" —
 * the point the frontend may fire a resolution celebration. PLACEHOLDER. */
export const PROJECTION_RESOLVE_CONFIDENCE = 0.85;

const PROJECTION_AGE_RANGE = { minWeeks: PROJECTION_YOUNG_AGE_WEEKS, maxWeeks: PROJECTION_MATURE_AGE_WEEKS };

/** A single attribute's ghost-cap read: what it is today, and the
 * scout's projection of where it can end up. `projected` is always >=
 * `current` (a projection can never be below what the player already
 * does). `mature: true` marks an attribute with no training headroom at
 * all (the mental cluster, which generates already-mature and never
 * trains — see docs/training-redesign-per-attribute.md): its projection
 * is exactly its current value, no ghost extension. */
export interface AttributeProjection {
  current: number;
  projected: number;
  mature: boolean;
}

export interface PotentialProjection {
  /** Headline projected-ceiling band (skill scale). low <= mid <= high;
   * all clamped to [currentOverall, 100]. Narrows toward a single value
   * (== the true ceiling) as the player ages. */
  projectedOverallLow: number;
  projectedOverallMid: number;
  projectedOverallHigh: number;
  /** RR-style development read: currentOverall / projectedMid, as a
   * whole percent in [1, 100]. "This player is at ~NN% of their
   * projected ceiling." */
  developmentPercent: number;
  /** Coarse headline label derived from the projected MID (not the
   * hidden truth) via the existing tierForPotentialCeiling thresholds. */
  tier: PotentialTier;
  /** 0 (youngest, maximally fuzzy) .. 1 (mature, resolved). Drives the
   * band width and the frontend's "scout confidence" copy. */
  confidence: number;
  /** confidence >= PROJECTION_RESOLVE_CONFIDENCE — the projection has
   * effectively converged on the truth; the frontend uses this to gate
   * the one-time resolution celebration. */
  resolved: boolean;
  /** A coarse, age-fuzzed read on the growth-RATE stat (talent), so the
   * "high talent, low current, wide-but-high projection" blue-chip card
   * §3 describes actually surfaces talent, without ever exposing the raw
   * number. Same tightening treatment as the ceiling band. */
  growth: 'slow' | 'steady' | 'rapid';
  attributes: {
    technical: Record<TechnicalAttribute, AttributeProjection>;
    physical: Record<PhysicalAttribute, AttributeProjection>;
    mental: Record<string, AttributeProjection>;
  };
}

export interface PotentialProjectionInput {
  /** Stable per-player seed source for the deterministic fuzz — the
   * player's own id. Never re-randomized. */
  playerId: string;
  ageInWeeks: number;
  attributes: PlayerAttributes;
  /** Hidden truth — overall ceiling anchor. Never leaves this service. */
  potentialCeiling: number;
  /** Hidden truth — per physical-attribute ceilings. Never leave this
   * service. */
  physicalCeilings: PhysicalCeilings;
  /** Hidden truth — growth-rate stat, only surfaced here as a coarse
   * fuzzed `growth` label. */
  talent: number;
}

const TECHNICAL_ATTRS: readonly TechnicalAttribute[] = ['serve', 'forehand', 'backhand', 'volley'];
const PHYSICAL_ATTRS: readonly PhysicalAttribute[] = ['speed', 'stamina', 'strength'];

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Deterministic string -> [0, 1) hash (FNV-1a variant). Stable across
 * processes and runs — the whole point is that a given (playerId, salt)
 * always yields the same fuzz, so a projection can't be re-rolled by
 * refetching. `salt` distinguishes independent draws for the same player
 * (the overall band vs. each attribute vs. the growth read) so their
 * biases aren't all identical. */
function stableUnit(playerId: string, salt: string): number {
  let h = 0x811c9dc5;
  const s = `${playerId}|${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 to unsigned, then normalize to [0, 1).
  return (h >>> 0) / 0x100000000;
}

/** 0 at PROJECTION_YOUNG_AGE_WEEKS (and below), 1 at
 * PROJECTION_MATURE_AGE_WEEKS (and above) — reuses the shared
 * ageInterpolationFactor shape, clamped to [0, 1] here (the shared
 * helper deliberately doesn't clamp; every OTHER caller only ever feeds
 * it an in-range age, but a real player's age genuinely runs past this
 * projection range in both directions, so clamping is correct here). */
function confidenceForAge(ageInWeeks: number): number {
  return clamp(ageInterpolationFactor(ageInWeeks, PROJECTION_AGE_RANGE), 0, 1);
}

/** Projects a single attribute toward its own true ceiling, fuzzed by
 * the same age-driven half-width and a per-attribute stable bias, then
 * clamped so the projection never drops below the current value and
 * never exceeds 100. */
function projectAttribute(
  playerId: string,
  salt: string,
  current: number,
  trueCeiling: number,
  confidence: number,
): number {
  const halfWidth = PROJECTION_MAX_HALF_WIDTH * (1 - confidence);
  const bias = stableUnit(playerId, salt) * 2 - 1; // [-1, 1]
  const projected = trueCeiling + bias * halfWidth * PROJECTION_BIAS_FRACTION;
  return Math.round(clamp(projected, current, 100));
}

/**
 * The one entry point. Pure — no I/O, no randomness beyond the stable
 * playerId hash, no dependency on wall-clock time. Given a player's
 * hidden truths and current attributes, returns the full profile-only
 * projection. Everything the caller is allowed to expose is in the
 * return value; the inputs (the raw ceilings/talent) must NOT be.
 */
export function projectPotential(input: PotentialProjectionInput): PotentialProjection {
  const { playerId, ageInWeeks, attributes, potentialCeiling, physicalCeilings, talent } = input;
  const confidence = confidenceForAge(ageInWeeks);
  const halfWidth = PROJECTION_MAX_HALF_WIDTH * (1 - confidence);

  // Headline overall band, centered on a biased read of the true
  // ceiling. The mid is what dev% and the tier label read off; low/high
  // frame the gamble.
  const currentOverall = Math.round(attributes.overallRating());
  const overallBias = stableUnit(playerId, 'overall') * 2 - 1; // [-1, 1]
  const rawMid = potentialCeiling + overallBias * halfWidth * PROJECTION_BIAS_FRACTION;
  const projectedOverallMid = Math.round(clamp(rawMid, currentOverall, 100));
  const projectedOverallLow = Math.round(clamp(rawMid - halfWidth, currentOverall, 100));
  const projectedOverallHigh = Math.round(clamp(rawMid + halfWidth, currentOverall, 100));

  const developmentPercent = clamp(Math.round((currentOverall / Math.max(1, projectedOverallMid)) * 100), 1, 100);
  const tier = tierForPotentialCeiling(projectedOverallMid);

  const technical = {} as Record<TechnicalAttribute, AttributeProjection>;
  for (const attr of TECHNICAL_ATTRS) {
    const current = attributes.technical[attr].value;
    // Technical attributes have NO hard training ceiling (see
    // Player.applyTraining) — the overall potentialCeiling is the honest
    // "how high can this player's game get" anchor to project them
    // toward, never below what they already do.
    technical[attr] = {
      current,
      projected: projectAttribute(playerId, `tech:${attr}`, current, potentialCeiling, confidence),
      mature: false,
    };
  }

  const physical = {} as Record<PhysicalAttribute, AttributeProjection>;
  for (const attr of PHYSICAL_ATTRS) {
    const current = attributes.physical[attr].value;
    physical[attr] = {
      current,
      projected: projectAttribute(playerId, `phys:${attr}`, current, physicalCeilings[attr], confidence),
      mature: false,
    };
  }

  // Mental attributes generate already mature and never train — no ghost
  // cap, projection == current.
  const mental: Record<string, AttributeProjection> = {};
  for (const [name, skill] of Object.entries(attributes.mental)) {
    const current = (skill as { value: number }).value;
    mental[name] = { current, projected: current, mature: true };
  }

  return {
    projectedOverallLow,
    projectedOverallMid,
    projectedOverallHigh,
    developmentPercent,
    tier,
    confidence: Math.round(confidence * 100) / 100,
    resolved: confidence >= PROJECTION_RESOLVE_CONFIDENCE,
    growth: growthRead(playerId, talent, confidence),
    attributes: { technical, physical, mental },
  };
}

/** Coarse three-way read on the hidden talent (growth-rate) stat, fuzzed
 * by age exactly like the ceiling band: while the scout is uncertain
 * (young player, low confidence) a stable per-player wobble can nudge the
 * read one band off; as confidence rises the wobble vanishes and the read
 * converges on the true band. Thresholds are PLACEHOLDER, matched to the
 * 25-95 talent generation range. */
function growthRead(playerId: string, talent: number, confidence: number): 'slow' | 'steady' | 'rapid' {
  const wobble = (stableUnit(playerId, 'growth') * 2 - 1) * (1 - confidence) * 15;
  const read = talent + wobble;
  if (read < 45) return 'slow';
  if (read < 72) return 'steady';
  return 'rapid';
}
