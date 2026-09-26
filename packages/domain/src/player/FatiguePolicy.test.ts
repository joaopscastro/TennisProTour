import { describe, it, expect } from 'vitest';
import {
  fatigueCostForMatch,
  fatigueRecoveredPerDay,
  BASE_MATCH_FATIGUE,
  FATIGUE_RECOVERY_PER_DAY,
  FATIGUE_RECOVERY_FRACTION,
  MAX_STAMINA_FATIGUE_RESISTANCE,
} from './FatiguePolicy';

describe('fatigueCostForMatch', () => {
  it('charges the full base cost to a zero-stamina player', () => {
    expect(fatigueCostForMatch(0)).toBe(BASE_MATCH_FATIGUE);
  });

  it('charges the minimum (fully resisted) cost to a max-stamina player', () => {
    const expected = Math.round(BASE_MATCH_FATIGUE * (1 - MAX_STAMINA_FATIGUE_RESISTANCE));
    expect(fatigueCostForMatch(100)).toBe(expected);
    expect(fatigueCostForMatch(100)).toBeLessThan(BASE_MATCH_FATIGUE);
  });

  it('is monotonically non-increasing in stamina', () => {
    let prev = fatigueCostForMatch(0);
    for (let s = 1; s <= 100; s++) {
      const cost = fatigueCostForMatch(s);
      expect(cost).toBeLessThanOrEqual(prev);
      prev = cost;
    }
  });

  it('clamps out-of-range stamina to [0, 100]', () => {
    expect(fatigueCostForMatch(-50)).toBe(fatigueCostForMatch(0));
    expect(fatigueCostForMatch(500)).toBe(fatigueCostForMatch(100));
  });
});

describe('fatigueRecoveredPerDay (self-limiting recovery)', () => {
  it('recovers the flat base alone at fatigue 0 — a rested player cannot "over-recover"', () => {
    expect(fatigueRecoveredPerDay(0)).toBe(FATIGUE_RECOVERY_PER_DAY);
  });

  it('adds a rounded fraction of CURRENT fatigue, so the more tired a player the faster they recover', () => {
    // 50 × 0.05 = 2.5 → round = 3
    expect(fatigueRecoveredPerDay(50)).toBe(FATIGUE_RECOVERY_PER_DAY + 3);
    // 26 × 0.05 = 1.3 → round = 1
    expect(fatigueRecoveredPerDay(26)).toBe(FATIGUE_RECOVERY_PER_DAY + 1);
    // 100 × 0.05 = 5
    expect(fatigueRecoveredPerDay(100)).toBe(FATIGUE_RECOVERY_PER_DAY + 5);
    for (let f = 1; f <= 100; f++) {
      expect(fatigueRecoveredPerDay(f)).toBeGreaterThanOrEqual(fatigueRecoveredPerDay(f - 1));
    }
  });

  it('produces a FINITE equilibrium for a heavy weekly schedule instead of the old ratchet to 100', () => {
    // Replays the production day loop exactly: each of the week's matches
    // on its own day (cost ~6 at stamina 50), then that day's recovery.
    const weeklySteadyState = (matchesPerWeek: number, costPerMatch: number): number => {
      let fatigue = 0;
      for (let week = 0; week < 52; week++) {
        for (let day = 1; day <= 7; day++) {
          if (day <= matchesPerWeek) fatigue = Math.min(100, fatigue + costPerMatch);
          fatigue = Math.max(0, Math.min(100, fatigue - fatigueRecoveredPerDay(fatigue)));
        }
      }
      return fatigue;
    };

    // A senior's title run (5 matches) settles at a real, finite value:
    // end-of-week ≈ 18, mid-week peak ≈ 26 (the design pass's headline
    // figure) — nowhere near the old ratchet to 100.
    const titleRun = weeklySteadyState(5, 6);
    expect(titleRun).toBeGreaterThan(15);
    expect(titleRun).toBeLessThan(40);

    // A major title run (7 matches) settles higher but still finite, and
    // strictly above the 5-match equilibrium — the mechanic is monotone.
    const majorRun = weeklySteadyState(7, 6);
    expect(majorRun).toBeGreaterThan(titleRun);
    expect(majorRun).toBeLessThanOrEqual(100);
    // The old fixed −3/day drain could only shed 21/week: at 42 fatigue
    // accrued a week this would have pinned at (or climbed toward) 100.
    // The fraction term is what keeps it finite.
    expect(FATIGUE_RECOVERY_FRACTION).toBeGreaterThan(0);

    // Idle: a 60-fatigue player recovers to ~26 within about a week.
    let idle = 60;
    for (let day = 0; day < 7; day++) idle -= fatigueRecoveredPerDay(idle);
    expect(idle).toBeGreaterThan(15);
    expect(idle).toBeLessThan(35);
  });

  it('clamps out-of-range fatigue and honours an explicit base override (the balance tool’s candidate comparison)', () => {
    expect(fatigueRecoveredPerDay(-50)).toBe(FATIGUE_RECOVERY_PER_DAY);
    expect(fatigueRecoveredPerDay(500)).toBe(FATIGUE_RECOVERY_PER_DAY + 5);
    expect(fatigueRecoveredPerDay(50, 5)).toBe(5 + 3);
  });
});
