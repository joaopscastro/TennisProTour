import { describe, expect, it } from 'vitest';
import { StandardTrainingPolicy, TrainingFocus, applyPotentialDiminishingReturns } from './TrainingPolicy';

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

describe('applyPotentialDiminishingReturns', () => {
  it('passes the base delta through unchanged when far below the ceiling', () => {
    // 15+ points of headroom -> full rate, no tapering at all.
    expect(applyPotentialDiminishingReturns(1.0, 30, 80)).toBe(1.0);
    expect(applyPotentialDiminishingReturns(1.0, 30, 45)).toBe(1.0); // exactly at the 15-point boundary
  });

  it('linearly tapers the delta as current approaches the ceiling, reaching exactly zero at it', () => {
    // Ceiling 80, 15-point taper range starts at current=65.
    expect(applyPotentialDiminishingReturns(1.0, 72.5, 80)).toBeCloseTo(0.5); // halfway through the range -> half rate
    expect(applyPotentialDiminishingReturns(1.0, 79, 80)).toBeCloseTo(1 / 15); // 1 point of headroom left
    expect(applyPotentialDiminishingReturns(1.0, 80, 80)).toBe(0); // exactly at the ceiling
  });

  it('clamps at zero rather than going negative once current exceeds the ceiling', () => {
    // A player above their own ceiling (e.g. via a lowered ceiling on
    // reconstitution) still gets zero growth, not a negative delta.
    expect(applyPotentialDiminishingReturns(1.0, 90, 80)).toBe(0);
  });

  it('never gates a non-positive (decay/zero) delta — only growth is throttled', () => {
    expect(applyPotentialDiminishingReturns(-0.05, 79, 80)).toBe(-0.05); // right at the ceiling, still decays normally
    expect(applyPotentialDiminishingReturns(0, 79, 80)).toBe(0);
  });
});
