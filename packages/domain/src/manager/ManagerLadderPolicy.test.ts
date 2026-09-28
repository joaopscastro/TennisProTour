import { describe, it, expect } from 'vitest';
import { StandardManagerLadderPolicy } from './ManagerLadderPolicy';
import { StandardRankingPointsTable } from '../competition/CompetitionTypes';

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

  it('pins the flat inactivity deduction (Batch 3: replaced the ×0.95 multiplier)', () => {
    expect(policy.inactivityPenaltyPoints()).toBe(500);
  });

  it('a rest week at a mid-ladder score can never cost more than one tour title banks', () => {
    // The live agent-season finding this replaced: at m3's 25,139 the
    // old multiplicative penalty cost ≈ −1,495 while a `tour` title
    // banks +1,000 — resting was strictly worse than playing at exactly
    // the moment the fatigue system asked for rest. With the flat
    // deduction the composed rest-week cost is `1% of score + 500`.
    const midLadderScore = 25_139;
    const titlePoints = new StandardRankingPointsTable().pointsFor('tour', 6); // a 64-draw tour title
    expect(titlePoints).toBe(1000); // the number the property is stated against

    const restWeekCost = midLadderScore * (1 - policy.weeklyDecayFactor()) + policy.inactivityPenaltyPoints();
    expect(restWeekCost).toBeLessThan(titlePoints);

    // What the old ×0.95 on top of the routine decay would have cost —
    // pinned so a regression to a proportional penalty fails here.
    const oldMultiplierCost = midLadderScore - midLadderScore * policy.weeklyDecayFactor() * 0.95;
    expect(oldMultiplierCost).toBeGreaterThan(titlePoints);
  });
});
