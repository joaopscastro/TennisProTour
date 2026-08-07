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

/** The three attribute groups PlayerAttributes is organized into.
 * Still used for read-only grouping (overallRating, the frontend
 * dropdown's Technical/Physical headers) — no longer a training axis
 * itself now that TrainingFocus selects a single attribute (see
 * TrainingPolicy.ts); 'mental' in particular can never be a training
 * target at all. */
export type SkillCluster = 'technical' | 'physical' | 'mental';

/** The four technical attributes — trainable, no hidden ceiling (see
 * docs/training-redesign-per-attribute.md: "open-ended, bounded only
 * by training investment and eventual decay"). */
export type TechnicalAttribute = 'serve' | 'forehand' | 'backhand' | 'volley';

/** The three physical attributes — trainable, each gated by its own
 * hidden per-attribute ceiling (see
 * PlayerGenerationPolicy.GeneratedPlayer.physicalCeilings and
 * Player.physicalCeilings). */
export type PhysicalAttribute = 'speed' | 'stamina' | 'strength';

/** Every attribute a TrainingFocus can target — deliberately EXCLUDES
 * 'consistency'/'clutch' (mental) at the type level: mental attributes
 * are never a training target, not because of a runtime check that
 * happens to reject them, but because there is no value of this union
 * that could ever name one. See TrainingFocus's doc comment. */
export type TrainableAttribute = TechnicalAttribute | PhysicalAttribute;

const PHYSICAL_ATTRIBUTES: readonly PhysicalAttribute[] = ['speed', 'stamina', 'strength'];

/** True for 'speed'/'stamina'/'strength', false for any TechnicalAttribute
 * — the one place this distinction is derived, so Player.applyTraining
 * doesn't need its own copy of this list. */
export function isPhysicalAttribute(attribute: TrainableAttribute): attribute is PhysicalAttribute {
  return (PHYSICAL_ATTRIBUTES as readonly string[]).includes(attribute);
}

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

  /** Current value of a single trainable attribute — used by
   * Player.applyTraining as the "how close to its own ceiling is THIS
   * attribute already" input to the potential-ceiling diminishing-
   * returns calculation (see TrainingPolicy.applyPotentialDiminishingReturns),
   * now computed per-attribute rather than as a cluster average, since
   * training targets exactly one attribute at a time. */
  attributeValue(attribute: TrainableAttribute): number {
    return isPhysicalAttribute(attribute) ? this.props.physical[attribute].value : this.props.technical[attribute].value;
  }

  /** Surface-focused training: bumps one surface affinity, leaves
   * every skill untouched. */
  trainedOnSurface(surface: Surface, gain: number): PlayerAttributes {
    return new PlayerAttributes({
      ...this.props,
      surfaceAffinities: this.props.surfaceAffinities.trainedOn(surface, gain),
    });
  }

  /** Attribute-focused training: bumps exactly ONE technical or
   * physical skill by delta, leaves every other skill (including the
   * rest of its own cluster), surface affinities, and mental
   * attributes entirely untouched — single-attribute selection per
   * docs/training-redesign-per-attribute.md, not the old "one delta
   * across a whole cluster" model. */
  trainedOnAttribute(attribute: TrainableAttribute, delta: number): PlayerAttributes {
    if (isPhysicalAttribute(attribute)) {
      return new PlayerAttributes({
        ...this.props,
        physical: { ...this.props.physical, [attribute]: this.props.physical[attribute].add(delta) },
      });
    }
    return new PlayerAttributes({
      ...this.props,
      technical: { ...this.props.technical, [attribute]: this.props.technical[attribute].add(delta) },
    });
  }
}
