import { describe, expect, it } from 'vitest';
import { StandardDoublesPairPolicy, doublesSideStrength, doublesPairStrength, orderDoublesFieldFillers } from './DoublesPairPolicy';
import { MatchParticipant } from './MatchSimulator';
import { PlayerAttributes, Skill, SurfaceAffinities } from '../player/PlayerAttributes';
import { PairId, PlayerId } from '../shared/ids';
import { weightedTechnicalAverage, weightedPhysicalAverage, weightedMentalAverage } from './SurfaceAttributeWeightingPolicy';
import { DOUBLES_SKILL_WEIGHT } from './StatisticalMatchSimulator';

function attrs(overall: number, doubles: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(overall), forehand: Skill.of(overall), backhand: Skill.of(overall), volley: Skill.of(overall) },
    physical: { speed: Skill.of(overall), stamina: Skill.of(overall), strength: Skill.of(overall) },
    mental: { consistency: Skill.of(overall), clutch: Skill.of(overall) },
    doubles: Skill.of(doubles),
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

function participant(id: string, overall: number, doubles: number, fatigue = 0, form = 15, home = false): MatchParticipant<PlayerId> {
  return { playerId: PlayerId(id), attributes: attrs(overall, doubles), fatigue, form, homeAdvantage: home };
}

describe('StandardDoublesPairPolicy', () => {
  it('averages the two players into one composite participant with a combined doublesSkill', () => {
    const policy = new StandardDoublesPairPolicy();
    const composite = policy.compositeParticipant(PairId('pair1'), participant('a', 60, 80), participant('b', 40, 20));

    expect(composite.playerId).toBe(PairId('pair1'));
    // attributes averaged: (60 + 40) / 2 = 50 for each skill
    expect(composite.attributes.technical.serve.value).toBe(50);
    expect(composite.attributes.physical.speed.value).toBe(50);
    // doublesSkill is the mean of the two players' doubles skills
    expect(composite.doublesSkill).toBe(50);
    // form averaged
    expect(composite.form).toBe(15);
  });

  it('takes the max fatigue and ORs home advantage', () => {
    const policy = new StandardDoublesPairPolicy();
    const composite = policy.compositeParticipant(
      PairId('pair1'),
      participant('a', 60, 50, 80, 15, true),
      participant('b', 60, 50, 20, 15, false),
    );

    expect(composite.fatigue).toBe(80); // max, not mean
    expect(composite.homeAdvantage).toBe(true); // either is home
  });
});

describe('doublesSideStrength / doublesPairStrength (field-composition measure)', () => {
  it('reads a player on the exact effective-rating scale the composite pair produces (plus the chemistry term)', () => {
    const policy = new StandardDoublesPairPolicy();
    const a = attrs(60, 80);
    const b = attrs(40, 20);
    const composite = policy.compositeParticipant(PairId('pair1'), participant('a', 60, 80), participant('b', 40, 20));

    // The composite's effective-rating contribution, re-derived from its
    // blended attributes with the same public weighting helpers the
    // simulator uses — pair strength must match it exactly for these
    // rounding-friendly inputs.
    const compositeRating =
      weightedTechnicalAverage(composite.attributes, 'hard') * 0.5 +
      weightedPhysicalAverage(composite.attributes, 'hard') * 0.3 +
      weightedMentalAverage(composite.attributes, 'hard') * 0.2 +
      composite.attributes.surfaceAffinities.get('hard') * 0.3 +
      DOUBLES_SKILL_WEIGHT * (composite.doublesSkill ?? 0);

    expect(doublesPairStrength(a, b, 'hard')).toBeCloseTo(compositeRating, 6);
    // Chemistry adds on the same scale, as the sim's CHEMISTRY_BONUS_PER_POINT does.
    expect(doublesPairStrength(a, b, 'hard', 100)).toBeCloseTo(compositeRating + 10, 6);
  });

  it('a flat-attribute arithmetic check: 60 + 0.3*20 (affinity) + 0.4*80 (doubles) = 98', () => {
    expect(doublesSideStrength(attrs(60, 80), 'hard')).toBeCloseTo(98, 6);
    // Pair = the mean of the two side strengths.
    expect(doublesPairStrength(attrs(60, 80), attrs(40, 20), 'hard')).toBeCloseTo((98 + 54) / 2, 6);
  });
});

describe('orderDoublesFieldFillers (cap-aware padding order)', () => {
  const candidate = (id: string, strength: number) => ({ playerId: PlayerId(id), strength });

  it('orders under-cap candidates strongest-first, then over-cap candidates weakest-first', () => {
    const ordered = orderDoublesFieldFillers(
      [candidate('weak', 40), candidate('over1', 130), candidate('mid', 90), candidate('over2', 120), candidate('best', 110)],
      115,
    );

    expect(ordered.map((c) => c.playerId)).toEqual([
      PlayerId('best'), // 110 — strongest under the cap
      PlayerId('mid'), // 90
      PlayerId('weak'), // 40
      PlayerId('over2'), // 120 — weakest over-cap first
      PlayerId('over1'), // 130
    ]);
  });

  it('treats the cap as inclusive, and is deterministic on equal strengths (id tie-break)', () => {
    const ordered = orderDoublesFieldFillers([candidate('b', 100), candidate('a', 100)], 100);
    expect(ordered.map((c) => c.playerId)).toEqual([PlayerId('a'), PlayerId('b')]);
  });

  it('returns every candidate exactly once (the caller slices what it needs)', () => {
    const ordered = orderDoublesFieldFillers([candidate('a', 10), candidate('b', 20), candidate('c', 30)], 15);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((c) => c.playerId)).size).toBe(3);
  });
});
