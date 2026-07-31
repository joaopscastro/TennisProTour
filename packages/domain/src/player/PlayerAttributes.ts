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
}
