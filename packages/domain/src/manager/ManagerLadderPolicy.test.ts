import { describe, it, expect } from 'vitest';
import { StandardManagerLadderPolicy } from './ManagerLadderPolicy';

describe('StandardManagerLadderPolicy', () => {
  const policy = new StandardManagerLadderPolicy();

  it('banks the same points a player earned (RR: managers accumulate all their players ranking points)', () => {
    expect(policy.creditFor(500)).toBe(500);
    expect(policy.creditFor(45)).toBe(45);
  });

  it('banks 0 for a 0-point result — the ladder only grows on a real win', () => {
    expect(policy.creditFor(0)).toBe(0);
  });

  it('decays a flat 1%/week', () => {
    expect(policy.weeklyDecayFactor()).toBe(0.99);
  });

  it('decay is erosive but never resets — repeated application trends toward, never reaches, zero', () => {
    let score = 1000;
    for (let week = 0; week < 5; week++) score *= policy.weeklyDecayFactor();
    // 1000 * 0.99^5 ≈ 950.99 — a real, gentle erosion.
    expect(score).toBeCloseTo(950.99, 1);
    expect(score).toBeLessThan(1000);
    expect(score).toBeGreaterThan(0);
  });

  it('applies a softened inactivity penalty — 5% extra on top of the routine 1%, not the old 15% cliff', () => {
    // Retuned 0.85 → 0.95 by the second fatigue/form pass: with fatigue
    // recovery now self-limiting, a rest week is a legitimate plan the
    // system itself nudges toward — so an inactive week must still cost
    // something real (~6% composed with the routine decay), but not so
    // much that resting is the wrong move at the exact moment fatigue
    // asks for it.
    expect(policy.inactivityPenaltyFactor()).toBe(0.95);
    expect(policy.weeklyDecayFactor() * policy.inactivityPenaltyFactor()).toBeCloseTo(0.9405, 4);
  });
});
