import { PlayerLifecycleStage } from './Player';
import { Surface, TrainableAttribute } from './PlayerAttributes';

/**
 * Exactly one training axis per session: either a surface, or a single
 * attribute — never both at once, and never a whole cluster at once
 * (superseded the old cluster-level model — see
 * docs/training-redesign-per-attribute.md). This is a deliberate
 * game-design constraint (a manager picks one focus per week), not
 * something this type happens to allow; a discriminated union enforces
 * it structurally rather than by convention, so there's no "surface
 * and attribute both set" state to guard against elsewhere.
 *
 * Mental attributes (consistency, clutch) can NEVER appear here — not
 * because of a runtime check that happens to reject them, but because
 * `TrainableAttribute` structurally excludes them. Attempting
 * `{ kind: 'attribute', attribute: 'consistency' }` is a TypeScript
 * compile error, not a value this type can ever hold at runtime.
 * "Personality isn't coached" is enforced by the type checker.
 */
export type TrainingFocus = { kind: 'surface'; surface: Surface } | { kind: 'attribute'; attribute: TrainableAttribute };

/**
 * Domain service seam (same swappable-policy pattern as AgingPolicy in
 * PlayerAgingService.ts): training gain-per-session is a policy that
 * may need to vary by game-world speed or later balance passes,
 * independent of what a Player *is*. Unlike aging — where
 * PlayerAgingService computes the full next PlayerAttributes outside
 * Player — training delegation happens one level down: Player itself
 * calls this policy to get a delta, then applies that delta via
 * PlayerAttributes' own trainedOnSurface()/trainedOnAttribute() methods.
 * Player's job stays "apply whatever delta I'm given," never "decide
 * how much training is worth."
 */
export interface TrainingPolicy {
  /** The attribute delta a single training session on this focus is
   * worth, for a player currently at this lifecycle stage. Positive
   * for surface affinity (percentage points, capped by
   * SurfaceAffinities itself) and for the trained attribute (0-100
   * points, capped by Skill itself). */
  computeDelta(focus: TrainingFocus, stage: PlayerLifecycleStage): number;
}

/**
 * Illustrative, not balanced — same caveat as StandardAgingPolicy's
 * stage thresholds and StandardRankingPointsTable's points formula:
 * safe to ship for validating the architecture, but worth a dedicated
 * tuning pass before launch. Younger players train faster; retired
 * players don't train at all (Player.applyTraining already rejects
 * them before this is ever called, but a stage-complete policy is
 * cheaper to keep correct than to special-case around).
 */
export class StandardTrainingPolicy implements TrainingPolicy {
  private static readonly DEFAULT_BASE_GAIN: Record<PlayerLifecycleStage, number> = {
    youth: 1.0,
    prime: 0.6,
    decline: 0.3,
    retired: 0,
  };

  /** Optional per-stage override — same pattern as
   * StatisticalMatchSimulator's `pointProbabilityDivisor` override and
   * StandardPlayerDevelopmentPolicy's XP-economy overrides: exists so
   * `apps/api/scripts/balance-simulation.mjs` can compare candidate
   * gain rates against real simulation data instead of editing this
   * private constant directly between runs. Absent = the class default
   * above, unchanged for every existing caller. Deliberately a full
   * Record override rather than one multiplier, since a real retuning
   * pass may want to change the stages' RELATIVE gaps too, not just
   * scale all four together. */
  constructor(private readonly BASE_GAIN: Record<PlayerLifecycleStage, number> = StandardTrainingPolicy.DEFAULT_BASE_GAIN) {}

  computeDelta(focus: TrainingFocus, stage: PlayerLifecycleStage): number {
    const base = this.BASE_GAIN[stage];
    // Surface affinity moves on a 0-60 scale with its own cap, so a
    // session is worth more raw points than the 0-100 attribute scale.
    // Technical and physical attributes train at the same base rate —
    // what differs between them is whether Player.applyTraining gates
    // the result by a hidden ceiling afterward, not this base amount.
    return focus.kind === 'surface' ? base * 2 : base;
  }
}

/** How close to a player's hidden ceiling (a physical attribute's own
 * entry in Player.physicalCeilings — see
 * PlayerGenerationPolicy.GeneratedPlayer.physicalCeilings) training
 * gains start tapering off, in skill points. Full-rate training up
 * until this close to the ceiling, then a linear falloff to zero
 * exactly at it — a player physically cannot be trained past what
 * they're capable of. */
const DIMINISHING_RETURNS_RANGE = 15;

/**
 * Scales a base training delta down as `current` approaches `ceiling`
 * — the mechanical form of "a hidden ceiling on how much an attribute
 * can grow via training." Deliberately a standalone function, not a
 * TrainingPolicy method: TrainingPolicy answers "how much is a session
 * worth in a vacuum" (stage/focus only, unrelated to any specific
 * player's ceiling), while this answers "how much of that actually
 * lands given how close this particular attribute already is to its
 * cap" — two different concerns that would otherwise force every
 * TrainingPolicy implementation to know about ceilings even if a
 * future game-world variant wanted to ignore them.
 *
 * The ONE saturation formula in this codebase for "smoothly approach a
 * hidden numeric cap, never abruptly stop or overshoot" — reused
 * as-is, not reimplemented, everywhere that shape of problem shows up.
 * Called for physical-attribute training only (Player.applyTraining,
 * with `current`/`ceiling` now a single attribute's own value and its
 * own physicalCeilings entry, not a cluster average against the old
 * single overall potentialCeiling). Technical-attribute training is
 * deliberately NOT gated by anything at all — see
 * docs/training-redesign-per-attribute.md: technical is open-ended,
 * bounded only by training investment and eventual decline-stage decay
 * (StandardAgingPolicy.weeklyDeclineDelta), never a ceiling. Surface
 * affinity training was never gated by a ceiling either, for the same
 * "unrelated axis" reasoning as before this redesign.
 */
export function applyPotentialDiminishingReturns(baseDelta: number, current: number, ceiling: number): number {
  if (baseDelta <= 0) return baseDelta; // only growth is gated, never decay
  const headroom = Math.max(0, ceiling - current);
  const factor = Math.min(1, headroom / DIMINISHING_RETURNS_RANGE);
  return baseDelta * factor;
}

/** PLACEHOLDER, not tuned — same discipline as DIMINISHING_RETURNS_RANGE
 * above and every other tuning constant in this codebase.
 * Linear scaling factor from a Coach's coachRating (0-100, see
 * CoachConversionPolicy) to a training-delta multiplier bonus — e.g.
 * coachRating 100 -> +50% training delta at this constant's current
 * value. */
const COACH_BONUS_PER_RATING_POINT = 0.005;

/**
 * A manager's coach (docs/manager-xp-and-coaching-system.md section 4)
 * applies a training-efficiency multiplier to a computed delta:
 * `finalDelta = baseDelta * (1 + coachBonus)`. Deliberately a
 * standalone function in the same spirit as
 * applyPotentialDiminishingReturns above — TrainingPolicy answers "how
 * much is a session worth in a vacuum" (stage/focus only), this
 * answers "how much more does this particular manager's coaching setup
 * make it worth," a different, orthogonal concern.
 *
 * Unlike applyPotentialDiminishingReturns (deliberately NOT applied to
 * surface-affinity training — see that function's doc comment), a
 * coach's benefit is general training efficiency, not tied to a
 * player's own intrinsic skill ceiling — so this DOES apply to both
 * surface and skill-cluster training (see Player.applyTraining). For
 * skill-cluster training specifically, this runs AFTER the potential-
 * ceiling diminishing-returns adjustment: a coach makes each session
 * more effective, but doesn't lift what's already been throttled by
 * how close a player is to their hidden ceiling.
 *
 * `coachRating` is null for a manager with no coach — the common case,
 * and the same "absence means no effect" convention as
 * applyPotentialDiminishingReturns' own gating. Like that function,
 * only growth (a positive delta) is ever boosted, never decay. */
export function applyCoachBonus(delta: number, coachRating: number | null): number {
  if (delta <= 0 || coachRating === null) return delta;
  return delta * (1 + coachRating * COACH_BONUS_PER_RATING_POINT);
}
