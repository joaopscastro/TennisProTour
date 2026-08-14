import { describe, expect, it } from 'vitest';
import { StandardDoublesPairPolicy } from './DoublesPairPolicy';
import { MatchParticipant } from './MatchSimulator';
import { PlayerAttributes, Skill, SurfaceAffinities } from '../player/PlayerAttributes';
import { PairId, PlayerId } from '../shared/ids';

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
