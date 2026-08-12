import { describe, expect, it } from 'vitest';
import { PlayerAttributes, Skill, SurfaceAffinities } from './PlayerAttributes';
import { PhysicalCeilings } from './PlayerGenerationPolicy';
import {
  PROJECTION_MATURE_AGE_WEEKS,
  PROJECTION_RESOLVE_CONFIDENCE,
  PROJECTION_YOUNG_AGE_WEEKS,
  PotentialProjectionInput,
  projectPotential,
} from './PotentialProjectionService';

function attrs(overrides?: {
  technical?: Partial<Record<'serve' | 'forehand' | 'backhand' | 'volley', number>>;
  physical?: Partial<Record<'speed' | 'stamina' | 'strength', number>>;
  mental?: Partial<Record<'consistency' | 'clutch', number>>;
}): PlayerAttributes {
  return new PlayerAttributes({
    technical: {
      serve: Skill.of(overrides?.technical?.serve ?? 40),
      forehand: Skill.of(overrides?.technical?.forehand ?? 40),
      backhand: Skill.of(overrides?.technical?.backhand ?? 40),
      volley: Skill.of(overrides?.technical?.volley ?? 40),
    },
    physical: {
      speed: Skill.of(overrides?.physical?.speed ?? 40),
      stamina: Skill.of(overrides?.physical?.stamina ?? 40),
      strength: Skill.of(overrides?.physical?.strength ?? 40),
    },
    mental: {
      consistency: Skill.of(overrides?.mental?.consistency ?? 70),
      clutch: Skill.of(overrides?.mental?.clutch ?? 70),
    },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

const CEILINGS: PhysicalCeilings = { speed: 80, stamina: 80, strength: 80 };

function input(overrides?: Partial<PotentialProjectionInput>): PotentialProjectionInput {
  return {
    playerId: 'player-abc',
    ageInWeeks: PROJECTION_YOUNG_AGE_WEEKS,
    attributes: attrs(),
    potentialCeiling: 82,
    physicalCeilings: CEILINGS,
    talent: 60,
    ...overrides,
  };
}

describe('projectPotential', () => {
  it('is deterministic — the same input yields byte-identical output (ungameable by refetch)', () => {
    const a = projectPotential(input());
    const b = projectPotential(input());
    expect(a).toEqual(b);
  });

  it('gives different players different fuzz at the same age (per-player stable bias)', () => {
    const one = projectPotential(input({ playerId: 'aaa' }));
    const two = projectPotential(input({ playerId: 'zzz' }));
    // Not asserting a specific direction, just that the stable hash
    // actually varies the read between players.
    const differs =
      one.projectedOverallMid !== two.projectedOverallMid ||
      one.projectedOverallLow !== two.projectedOverallLow ||
      one.growth !== two.growth;
    expect(differs).toBe(true);
  });

  it('narrows toward truth as the player ages — band width shrinks, mid converges on the true ceiling', () => {
    const young = projectPotential(input({ ageInWeeks: PROJECTION_YOUNG_AGE_WEEKS }));
    const mid = projectPotential(input({ ageInWeeks: (PROJECTION_YOUNG_AGE_WEEKS + PROJECTION_MATURE_AGE_WEEKS) / 2 }));
    const old = projectPotential(input({ ageInWeeks: PROJECTION_MATURE_AGE_WEEKS }));

    const widthOf = (p: { projectedOverallHigh: number; projectedOverallLow: number }) =>
      p.projectedOverallHigh - p.projectedOverallLow;

    expect(widthOf(young)).toBeGreaterThan(widthOf(mid));
    expect(widthOf(mid)).toBeGreaterThanOrEqual(widthOf(old));

    // At/after maturity the band collapses onto the true ceiling.
    expect(old.projectedOverallLow).toBe(82);
    expect(old.projectedOverallMid).toBe(82);
    expect(old.projectedOverallHigh).toBe(82);
    expect(old.confidence).toBe(1);
    expect(old.resolved).toBe(true);
  });

  it('confidence and resolved track age', () => {
    expect(projectPotential(input({ ageInWeeks: PROJECTION_YOUNG_AGE_WEEKS })).confidence).toBe(0);
    expect(projectPotential(input({ ageInWeeks: PROJECTION_YOUNG_AGE_WEEKS })).resolved).toBe(false);

    const resolvedAge =
      PROJECTION_YOUNG_AGE_WEEKS +
      Math.ceil((PROJECTION_MATURE_AGE_WEEKS - PROJECTION_YOUNG_AGE_WEEKS) * PROJECTION_RESOLVE_CONFIDENCE);
    expect(projectPotential(input({ ageInWeeks: resolvedAge })).resolved).toBe(true);
  });

  it('clamps ages outside the projection range (younger than youngest, older than mature)', () => {
    const babied = projectPotential(input({ ageInWeeks: 10 * 52 }));
    expect(babied.confidence).toBe(0);
    const veteran = projectPotential(input({ ageInWeeks: 34 * 52 }));
    expect(veteran.confidence).toBe(1);
    expect(veteran.projectedOverallMid).toBe(82);
  });

  it('never projects below the current value nor above 100', () => {
    // Player already stronger than their (contrived-low) ceiling: the
    // projection must not report a downgrade.
    const strongNow = projectPotential(
      input({
        attributes: attrs({ technical: { serve: 90, forehand: 90, backhand: 90, volley: 90 } }),
        potentialCeiling: 50,
        physicalCeilings: { speed: 40, stamina: 40, strength: 40 },
        ageInWeeks: PROJECTION_YOUNG_AGE_WEEKS,
      }),
    );
    const currentOverall = Math.round(strongNow.projectedOverallLow); // low is clamped to currentOverall floor
    expect(strongNow.projectedOverallLow).toBeGreaterThanOrEqual(currentOverall);
    for (const group of [strongNow.attributes.technical, strongNow.attributes.physical]) {
      for (const a of Object.values(group)) {
        expect(a.projected).toBeGreaterThanOrEqual(a.current);
        expect(a.projected).toBeLessThanOrEqual(100);
      }
    }
  });

  it('projects physical attributes toward their own per-attribute ceilings', () => {
    // Fully mature -> projection lands exactly on each true physical ceiling.
    const p = projectPotential(
      input({
        ageInWeeks: PROJECTION_MATURE_AGE_WEEKS,
        physicalCeilings: { speed: 88, stamina: 61, strength: 74 },
        attributes: attrs({ physical: { speed: 40, stamina: 40, strength: 40 } }),
      }),
    );
    expect(p.attributes.physical.speed.projected).toBe(88);
    expect(p.attributes.physical.stamina.projected).toBe(61);
    expect(p.attributes.physical.strength.projected).toBe(74);
  });

  it('treats mental attributes as mature — projection equals current, flagged mature', () => {
    const p = projectPotential(input({ attributes: attrs({ mental: { consistency: 66, clutch: 71 } }) }));
    expect(p.attributes.mental.consistency).toEqual({ current: 66, projected: 66, mature: true });
    expect(p.attributes.mental.clutch).toEqual({ current: 71, projected: 71, mature: true });
  });

  it('reports development percent as current/projectedMid', () => {
    const p = projectPotential(input({ ageInWeeks: PROJECTION_MATURE_AGE_WEEKS }));
    // currentOverall = mean of 40*7 + 70*2 = (280+140)/9 = 46.67 -> 47; mid = 82.
    expect(p.developmentPercent).toBe(Math.round((47 / 82) * 100));
  });

  it('surfaces talent as a coarse growth read that resolves with age', () => {
    const rapidMature = projectPotential(input({ talent: 90, ageInWeeks: PROJECTION_MATURE_AGE_WEEKS }));
    expect(rapidMature.growth).toBe('rapid');
    const slowMature = projectPotential(input({ talent: 30, ageInWeeks: PROJECTION_MATURE_AGE_WEEKS }));
    expect(slowMature.growth).toBe('slow');
    const steadyMature = projectPotential(input({ talent: 60, ageInWeeks: PROJECTION_MATURE_AGE_WEEKS }));
    expect(steadyMature.growth).toBe('steady');
  });
});
