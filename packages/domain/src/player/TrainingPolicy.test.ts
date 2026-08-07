import { describe, expect, it } from 'vitest';
import { StandardTrainingPolicy, TrainingFocus, applyCoachBonus, applyPotentialDiminishingReturns } from './TrainingPolicy';

describe('StandardTrainingPolicy', () => {
  const policy = new StandardTrainingPolicy();

  it('computes a surface-focus delta that scales with stage, at double the skill-cluster rate', () => {
    const surfaceFocus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    expect(policy.computeDelta(surfaceFocus, 'youth')).toBe(2.0);
    expect(policy.computeDelta(surfaceFocus, 'prime')).toBe(1.2);
    expect(policy.computeDelta(surfaceFocus, 'decline')).toBeCloseTo(0.6);
  });

  it('computes an attribute-focus delta that scales with stage, identically for a technical and a physical attribute', () => {
    const technicalFocus: TrainingFocus = { kind: 'attribute', attribute: 'serve' };
    const physicalFocus: TrainingFocus = { kind: 'attribute', attribute: 'speed' };

    for (const focus of [technicalFocus, physicalFocus]) {
      expect(policy.computeDelta(focus, 'youth')).toBe(1.0);
      expect(policy.computeDelta(focus, 'prime')).toBe(0.6);
      expect(policy.computeDelta(focus, 'decline')).toBeCloseTo(0.3);
    }
  });

  it('gives a surface focus exactly double an attribute focus at the same stage', () => {
    const surfaceFocus: TrainingFocus = { kind: 'surface', surface: 'hard' };
    const attributeFocus: TrainingFocus = { kind: 'attribute', attribute: 'stamina' };

    expect(policy.computeDelta(surfaceFocus, 'prime')).toBe(2 * policy.computeDelta(attributeFocus, 'prime'));
  });

  it('returns zero for a retired player regardless of focus', () => {
    expect(policy.computeDelta({ kind: 'surface', surface: 'grass' }, 'retired')).toBe(0);
    expect(policy.computeDelta({ kind: 'attribute', attribute: 'strength' }, 'retired')).toBe(0);
  });
});

describe('TrainingFocus type safety', () => {
  it('cannot be constructed to target a mental attribute — enforced at compile time, not by a runtime check', () => {
    // @ts-expect-error — 'consistency' is not a TrainableAttribute (TechnicalAttribute | PhysicalAttribute);
    // mental attributes can never be a TrainingFocus target, structurally, not via a check that happens to reject them.
    const targetingConsistency: TrainingFocus = { kind: 'attribute', attribute: 'consistency' };
    // @ts-expect-error — same for 'clutch', the other mental attribute.
    const targetingClutch: TrainingFocus = { kind: 'attribute', attribute: 'clutch' };
    // What actually proves the impossibility is `npx tsc --noEmit --strict`
    // failing on THIS FILE if either line above were NOT a type error: an
    // unused `@ts-expect-error` directive is itself a compile error. This
    // test's runtime pass/fail is incidental — both lines execute fine as
    // plain JS, since erasing the types leaves ordinary object literals.
    expect(targetingConsistency).toBeDefined();
    expect(targetingClutch).toBeDefined();
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

describe('applyCoachBonus', () => {
  it('passes the delta through unchanged when there is no coach (null)', () => {
    expect(applyCoachBonus(1.0, null)).toBe(1.0);
  });

  it('boosts a positive delta, scaling with coachRating', () => {
    const bonusAt50 = applyCoachBonus(1.0, 50) - 1.0;
    const bonusAt100 = applyCoachBonus(1.0, 100) - 1.0;
    expect(bonusAt50).toBeGreaterThan(0);
    expect(bonusAt100).toBeGreaterThan(bonusAt50);
  });

  it('never boosts a non-positive (decay/zero) delta, even with a coach', () => {
    expect(applyCoachBonus(-0.05, 80)).toBe(-0.05);
    expect(applyCoachBonus(0, 80)).toBe(0);
  });

  it('a coachRating of 0 is a no-op (matches the null case)', () => {
    expect(applyCoachBonus(1.0, 0)).toBe(1.0);
  });
});
