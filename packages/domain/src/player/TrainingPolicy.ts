import { PlayerLifecycleStage } from './Player';
import { Surface, SkillCluster } from './PlayerAttributes';

/**
 * Exactly one training axis per session: either a surface, or a skill
 * cluster — never both at once. This is a deliberate game-design
 * constraint (a manager picks one focus per week), not something this
 * type happens to allow; a discriminated union enforces it structurally
 * rather than by convention, so there's no "surface and cluster both
 * set" state to guard against elsewhere.
 */
export type TrainingFocus = { kind: 'surface'; surface: Surface } | { kind: 'skill'; cluster: SkillCluster };

/**
 * Domain service seam (same swappable-policy pattern as AgingPolicy in
 * PlayerAgingService.ts): training gain-per-session is a policy that
 * may need to vary by game-world speed or later balance passes,
 * independent of what a Player *is*. Unlike aging — where
 * PlayerAgingService computes the full next PlayerAttributes outside
 * Player — training delegation happens one level down: Player itself
 * calls this policy to get a delta, then applies that delta via
 * PlayerAttributes' own trainedOnSurface()/trainedOnCluster() methods.
 * Player's job stays "apply whatever delta I'm given," never "decide
 * how much training is worth."
 */
export interface TrainingPolicy {
  /** The attribute delta a single training session on this focus is
   * worth, for a player currently at this lifecycle stage. Positive
   * for surface affinity (percentage points, capped by
   * SurfaceAffinities itself) and for skill clusters (0-100 points,
   * capped by Skill itself). */
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
  private readonly BASE_GAIN: Record<PlayerLifecycleStage, number> = {
    youth: 1.0,
    prime: 0.6,
    decline: 0.3,
    retired: 0,
  };

  computeDelta(focus: TrainingFocus, stage: PlayerLifecycleStage): number {
    const base = this.BASE_GAIN[stage];
    // Surface affinity moves on a 0-60 scale with its own cap, so a
    // session is worth more raw points than the 0-100 skill clusters.
    return focus.kind === 'surface' ? base * 2 : base;
  }
}
