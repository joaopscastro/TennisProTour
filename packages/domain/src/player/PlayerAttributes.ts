export type Surface = 'clay' | 'grass' | 'hard' | 'indoor';

/** A single 0–100 rated attribute. Immutable — every change returns a
 * new Skill, so a Player's attribute history can never be mutated out
 * from under a caller holding an old reference. */
export class Skill {
  private constructor(private readonly _value: number) {}

  static of(value: number): Skill {
    if (value < 0 || value > 100) {
      throw new Error(`Skill value out of range [0, 100]: ${value}`);
    }
    return new Skill(value);
  }

  get value(): number {
    return this._value;
  }

  adjust(delta: number): Skill {
    return Skill.of(Math.min(100, Math.max(0, this._value + delta)));
  }
}

export class SurfaceAffinities {
  private constructor(private readonly affinities: ReadonlyMap<Surface, number>) {}

  static of(values: Record<Surface, number>): SurfaceAffinities {
    return new SurfaceAffinities(new Map(Object.entries(values) as Array<[Surface, number]>));
  }

  get(surface: Surface): number {
    const value = this.affinities.get(surface);
    if (value === undefined) {
      throw new Error(`No affinity defined for surface: ${surface}`);
    }
    return value;
  }

  with(surface: Surface, value: number): SurfaceAffinities {
    const next = new Map(this.affinities);
    next.set(surface, value);
    return new SurfaceAffinities(next);
  }
}

export interface TechnicalAttributes {
  serve: Skill;
  forehand: Skill;
  backhand: Skill;
  volley: Skill;
}

export interface PhysicalAttributes {
  speed: Skill;
  stamina: Skill;
  strength: Skill;
}

export interface MentalAttributes {
  consistency: Skill;
  clutch: Skill;
}

/** Groups the three stat categories plus surface affinities — directly
 * inspired by Rocking Rackets' model but split into technical/physical
 * /mental groups for more build-diversity granularity (see business
 * plan, section 2). */
export class PlayerAttributes {
  private constructor(
    readonly technical: TechnicalAttributes,
    readonly physical: PhysicalAttributes,
    readonly mental: MentalAttributes,
    readonly surfaceAffinities: SurfaceAffinities,
  ) {}

  static create(params: {
    technical: TechnicalAttributes;
    physical: PhysicalAttributes;
    mental: MentalAttributes;
    surfaceAffinities: SurfaceAffinities;
  }): PlayerAttributes {
    return new PlayerAttributes(params.technical, params.physical, params.mental, params.surfaceAffinities);
  }

  withTechnical(patch: Partial<TechnicalAttributes>): PlayerAttributes {
    return new PlayerAttributes({ ...this.technical, ...patch }, this.physical, this.mental, this.surfaceAffinities);
  }

  withPhysical(patch: Partial<PhysicalAttributes>): PlayerAttributes {
    return new PlayerAttributes(this.technical, { ...this.physical, ...patch }, this.mental, this.surfaceAffinities);
  }

  withMental(patch: Partial<MentalAttributes>): PlayerAttributes {
    return new PlayerAttributes(this.technical, this.physical, { ...this.mental, ...patch }, this.surfaceAffinities);
  }
}
