/**
 * Value objects for a player's attributes. All are immutable — any
 * "change" (training, aging) produces a new instance rather than
 * mutating in place, which keeps Player.ts's invariants easy to reason
 * about and trivial to unit test.
 */

/** A single 0–100 skill rating. Clamps itself on construction so no
 * consumer needs to re-validate bounds (SRP: this VO owns its own
 * validity, nothing else needs to). */
export class Skill {
  private constructor(readonly value: number) {}

  static of(value: number): Skill {
    return new Skill(Math.max(0, Math.min(100, Math.round(value))));
  }

  add(delta: number): Skill {
    return Skill.of(this.value + delta);
  }

  toBallRating(): number {
    // Rocking Rackets-style presentation: 20 skill points ≈ 1 "ball" icon
    return this.value / 20;
  }
}

export type Surface = 'clay' | 'grass' | 'hard' | 'indoor';

/** The three attribute groups PlayerAttributes is organized into —
 * the other training axis alongside Surface (see TrainingFocus). */
export type SkillCluster = 'technical' | 'physical' | 'mental';

/**
 * Percentage bonus per surface. Mirrors Rocking Rackets' rule that each
 * surface affinity is trainable but capped at 60%, and the four
 * surfaces needn't sum to any fixed total (unlike a "distribute 100
 * points" allocation system, which would add UI complexity we don't
 * need at MVP).
 */
export class SurfaceAffinities {
  private static readonly MAX_PER_SURFACE = 60;

  private constructor(private readonly values: Record<Surface, number>) {}

  static initial(): SurfaceAffinities {
    return new SurfaceAffinities({ clay: 20, grass: 20, hard: 20, indoor: 20 });
  }

  /** Rehydrates stored affinity values (persistence adapters). Values
   * were validated when originally produced via initial()/trainedOn(),
   * so this does not re-cap them. */
  static of(values: Record<Surface, number>): SurfaceAffinities {
    return new SurfaceAffinities({ ...values });
  }

  get(surface: Surface): number {
    return this.values[surface];
  }

  trainedOn(surface: Surface, gain: number): SurfaceAffinities {
    const next = { ...this.values };
    next[surface] = Math.min(SurfaceAffinities.MAX_PER_SURFACE, next[surface] + gain);
    return new SurfaceAffinities(next);
  }
}

export interface PlayerAttributesProps {
  technical: {
    serve: Skill;
    forehand: Skill;
    backhand: Skill;
    volley: Skill;
  };
  physical: {
    speed: Skill;
    stamina: Skill;
    strength: Skill;
  };
  mental: {
    consistency: Skill;
    clutch: Skill; // "mentality" in Rocking Rackets terms — bonus on break/tiebreak points
  };
  surfaceAffinities: SurfaceAffinities;
}

/** Groups the three attribute clusters (technical / physical / mental)
 * plus surface affinities into a single immutable snapshot that the
 * Match Simulation Engine consumes. This is the seam between the
 * Player & Roster context and the Match Simulation context — the
 * simulator only ever sees this plain snapshot, never the Player
 * entity itself, which keeps the two contexts decoupled. */
export class PlayerAttributes {
  constructor(private readonly props: PlayerAttributesProps) {}

  get technical() {
    return this.props.technical;
  }

  get physical() {
    return this.props.physical;
  }

  get mental() {
    return this.props.mental;
  }

  get surfaceAffinities() {
    return this.props.surfaceAffinities;
  }

  overallRating(): number {
    const all = [
      ...Object.values(this.props.technical),
      ...Object.values(this.props.physical),
      ...Object.values(this.props.mental),
    ] as Skill[];
    return all.reduce((sum, s) => sum + s.value, 0) / all.length;
  }

  /** Average current value across one skill cluster — used by
   * Player.applyTraining as the "how close to the ceiling is this
   * cluster already" input to the potential-ceiling diminishing-
   * returns calculation (see TrainingPolicy.applyPotentialDiminishingReturns).
   * A cluster average rather than per-skill deltas is a deliberate
   * simplification: trainedOnCluster() already applies one uniform
   * delta to every skill in a cluster, so gating that single delta by
   * the cluster's average proximity to the ceiling keeps the
   * ceiling mechanic consistent with the existing "one delta per
   * cluster" training model instead of requiring per-skill ceiling
   * tracking. */
  clusterAverage(cluster: SkillCluster): number {
    const values = Object.values(this.props[cluster]) as Skill[];
    return values.reduce((sum, s) => sum + s.value, 0) / values.length;
  }

  /** Surface-focused training: bumps one surface affinity, leaves
   * every skill cluster untouched. */
  trainedOnSurface(surface: Surface, gain: number): PlayerAttributes {
    return new PlayerAttributes({
      ...this.props,
      surfaceAffinities: this.props.surfaceAffinities.trainedOn(surface, gain),
    });
  }

  /** Skill-focused training: bumps every skill in one cluster by the
   * same delta, leaves surface affinities and the other two clusters
   * untouched. */
  trainedOnCluster(cluster: SkillCluster, delta: number): PlayerAttributes {
    switch (cluster) {
      case 'technical':
        return new PlayerAttributes({
          ...this.props,
          technical: {
            serve: this.props.technical.serve.add(delta),
            forehand: this.props.technical.forehand.add(delta),
            backhand: this.props.technical.backhand.add(delta),
            volley: this.props.technical.volley.add(delta),
          },
        });
      case 'physical':
        return new PlayerAttributes({
          ...this.props,
          physical: {
            speed: this.props.physical.speed.add(delta),
            stamina: this.props.physical.stamina.add(delta),
            strength: this.props.physical.strength.add(delta),
          },
        });
      case 'mental':
        return new PlayerAttributes({
          ...this.props,
          mental: {
            consistency: this.props.mental.consistency.add(delta),
            clutch: this.props.mental.clutch.add(delta),
          },
        });
    }
  }
}
