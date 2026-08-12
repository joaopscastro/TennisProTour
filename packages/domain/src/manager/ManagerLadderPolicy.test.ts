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
});
