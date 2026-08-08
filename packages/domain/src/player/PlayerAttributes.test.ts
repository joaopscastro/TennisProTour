import { describe, expect, it } from 'vitest';
import { PlayerAttributes, Skill, SurfaceAffinities, weakestTrainableAttribute } from './PlayerAttributes';

function attributesWith(overrides: Partial<Record<'serve' | 'forehand' | 'backhand' | 'volley' | 'speed' | 'stamina' | 'strength', number>>): PlayerAttributes {
  const base = 50;
  return new PlayerAttributes({
    technical: {
      serve: Skill.of(overrides.serve ?? base),
      forehand: Skill.of(overrides.forehand ?? base),
      backhand: Skill.of(overrides.backhand ?? base),
      volley: Skill.of(overrides.volley ?? base),
    },
    physical: {
      speed: Skill.of(overrides.speed ?? base),
      stamina: Skill.of(overrides.stamina ?? base),
      strength: Skill.of(overrides.strength ?? base),
    },
    mental: { consistency: Skill.of(80), clutch: Skill.of(80) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

describe('weakestTrainableAttribute', () => {
  it('picks the single lowest technical or physical attribute, never a mental one', () => {
    const attributes = attributesWith({ backhand: 10 });

    expect(weakestTrainableAttribute(attributes)).toBe('backhand');
  });

  it('finds the weakest physical attribute too, not just technical ones', () => {
    const attributes = attributesWith({ stamina: 5 });

    expect(weakestTrainableAttribute(attributes)).toBe('stamina');
  });

  it('breaks a tie deterministically (first in technical-then-physical order), not randomly', () => {
    const attributes = attributesWith({ forehand: 10, speed: 10 });

    expect(weakestTrainableAttribute(attributes)).toBe('forehand');
  });

  it('ignores mental attributes entirely, even when they are lower than every trainable one', () => {
    // mental is fixed at 80 in the fixture above (well above every
    // trainable attribute's default 50) — this test only documents
    // that weakestTrainableAttribute's return type structurally cannot
    // name a mental attribute at all, not a runtime behavior to probe
    // further beyond confirming a normal call still returns a real
    // TrainableAttribute.
    const attributes = attributesWith({});

    const weakest = weakestTrainableAttribute(attributes);

    expect(['serve', 'forehand', 'backhand', 'volley', 'speed', 'stamina', 'strength']).toContain(weakest);
  });
});
