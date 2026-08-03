import { describe, expect, it } from 'vitest';
import { StandardTrainingPolicy, TrainingFocus } from './TrainingPolicy';

describe('StandardTrainingPolicy', () => {
  const policy = new StandardTrainingPolicy();

  it('computes a surface-focus delta that scales with stage, at double the skill-cluster rate', () => {
    const surfaceFocus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    expect(policy.computeDelta(surfaceFocus, 'youth')).toBe(2.0);
    expect(policy.computeDelta(surfaceFocus, 'prime')).toBe(1.2);
    expect(policy.computeDelta(surfaceFocus, 'decline')).toBeCloseTo(0.6);
  });

  it('computes a skill-cluster-focus delta that scales with stage', () => {
    const skillFocus: TrainingFocus = { kind: 'skill', cluster: 'technical' };

    expect(policy.computeDelta(skillFocus, 'youth')).toBe(1.0);
    expect(policy.computeDelta(skillFocus, 'prime')).toBe(0.6);
    expect(policy.computeDelta(skillFocus, 'decline')).toBeCloseTo(0.3);
  });

  it('gives a surface focus exactly double a skill-cluster focus at the same stage', () => {
    const surfaceFocus: TrainingFocus = { kind: 'surface', surface: 'hard' };
    const skillFocus: TrainingFocus = { kind: 'skill', cluster: 'mental' };

    expect(policy.computeDelta(surfaceFocus, 'prime')).toBe(2 * policy.computeDelta(skillFocus, 'prime'));
  });

  it('returns zero for a retired player regardless of focus', () => {
    expect(policy.computeDelta({ kind: 'surface', surface: 'grass' }, 'retired')).toBe(0);
    expect(policy.computeDelta({ kind: 'skill', cluster: 'physical' }, 'retired')).toBe(0);
  });
});
