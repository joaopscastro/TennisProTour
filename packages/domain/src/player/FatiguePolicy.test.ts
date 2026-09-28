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
    expect(fatigueRecoveredPerDay(50)).toBe(FATIGUE_RECOVERY_PER_DAY + 4);
    // 26 × 0.08 = 2.08 -> round = 2
    expect(fatigueRecoveredPerDay(26)).toBe(FATIGUE_RECOVERY_PER_DAY + 2);
    // 100 × 0.08 = 8
    expect(fatigueRecoveredPerDay(100)).toBe(FATIGUE_RECOVERY_PER_DAY + 8);
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
        const perDay = Math.floor(matchesPerWeek / 7);
        const extra = matchesPerWeek % 7;
        for (let day = 1; day <= 7; day++) {
          const today = perDay + (day <= extra ? 1 : 0);
          for (let m = 0; m < today; m++) fatigue = Math.min(100, fatigue + costPerMatch);
          fatigue = Math.max(0, Math.min(100, fatigue - fatigueRecoveredPerDay(fatigue)));
        }
      }
      return fatigue;
    };

    // A senior's title run (5 matches) settles LOW; the second pass's
    // fixed drain put this at 91 before the self-limiting recovery, and
    // the third pass (recovery fraction 0.05 → 0.08) brought it down
    // further so the elite loads below have real headroom.
    const titleRun = weeklySteadyState(5, 6);
    expect(titleRun).toBeGreaterThan(5);
    expect(titleRun).toBeLessThan(15);

    // A major title run (7 matches) settles higher but still low, and
    // strictly above the 5-match equilibrium — the mechanic is monotone.
    const majorRun = weeklySteadyState(7, 6);
    expect(majorRun).toBeGreaterThan(titleRun);
    expect(majorRun).toBeLessThan(35);
    // The fraction term is what keeps the equilibrium finite.
    expect(FATIGUE_RECOVERY_FRACTION).toBeGreaterThan(0);

    // The MEASURED PROBLEM this retune fixes: a realistic elite load of
    // 9-11 matches/week (one senior tournament's singles + doubles deep
    // runs — the volume Batch 4B's second weekly tour made routine) must
    // oscillate inside the manageable 40-80 band. Before the retune the
    // same schedules sat at 80/88 (9 matches) and 86/92 (11) and stayed
    // there all season — singles deep runs became coin-flips.
    const elite9 = weeklySteadyState(9, 6);
    const elite11 = weeklySteadyState(11, 6);
    expect(elite9).toBeGreaterThanOrEqual(40);
    expect(elite9).toBeLessThanOrEqual(80);
    expect(elite11).toBeGreaterThanOrEqual(40);
    expect(elite11).toBeLessThanOrEqual(80);
    expect(elite11).toBeGreaterThan(elite9);

    // An occasional 14-match week (both finals at a major) stays finite
    // and recovers in a following idle week — rest/taper is a real plan,
    // not a trap, and fatigue never ratchets to the ceiling.
    const peak14 = weeklySteadyState(14, 6);
    expect(peak14).toBeGreaterThan(elite11);
    expect(peak14).toBeLessThan(100);
    let recoveredFromPeak = peak14;
    for (let day = 0; day < 7; day++) recoveredFromPeak -= fatigueRecoveredPerDay(recoveredFromPeak);
    expect(recoveredFromPeak).toBeLessThan(elite9);

    // Idle: a 60-fatigue player recovers close to the title-run level
    // within about a week.
    let idle = 60;
    for (let day = 0; day < 7; day++) idle -= fatigueRecoveredPerDay(idle);
    expect(idle).toBeGreaterThan(10);
    expect(idle).toBeLessThan(30);
  });

  it('clamps out-of-range fatigue and honours an explicit base override (the balance tool’s candidate comparison)', () => {
    expect(fatigueRecoveredPerDay(-50)).toBe(FATIGUE_RECOVERY_PER_DAY);
    expect(fatigueRecoveredPerDay(500)).toBe(FATIGUE_RECOVERY_PER_DAY + 8);
    expect(fatigueRecoveredPerDay(50, 5)).toBe(5 + 4);
  });
});
