import { describe, expect, it } from 'vitest';
import { applyGraduationCarryover, computeGraduationCarryover, GRADUATION_CARRYOVER_FRACTION } from './GraduationCarryover';

describe('computeGraduationCarryover', () => {
  it('sizes the bonus as GRADUATION_CARRYOVER_FRACTION of the old band total', () => {
    const bonus = computeGraduationCarryover('u16', 200);
    expect(bonus).toEqual({ targetBand: 'u16', bonusPoints: 200 * GRADUATION_CARRYOVER_FRACTION });
  });

  it('returns null when the old band total is 0 — nothing to carry over', () => {
    expect(computeGraduationCarryover('u16', 0)).toBeNull();
  });

  it('returns null for a negative old band total (defensive — totals are never negative in practice)', () => {
    expect(computeGraduationCarryover('senior', -5)).toBeNull();
  });
});

describe('applyGraduationCarryover', () => {
  it('does NOT consume the bonus, and does not boost, when there is no dormant bonus at all', () => {
    const result = applyGraduationCarryover(50, 'u16', null);
    expect(result).toEqual({ points: 50, consumed: false });
  });

  it('does NOT consume or boost when the dormant bonus targets a different band', () => {
    const dormant = { targetBand: 'u16' as const, bonusPoints: 100 };
    const result = applyGraduationCarryover(50, 'senior', dormant);
    expect(result).toEqual({ points: 50, consumed: false });
  });

  it('does NOT consume or boost a 0-point entry (a first-round loss) even when the band matches — only a real win qualifies', () => {
    const dormant = { targetBand: 'u16' as const, bonusPoints: 100 };
    const result = applyGraduationCarryover(0, 'u16', dormant);
    expect(result).toEqual({ points: 0, consumed: false });
  });

  it('boosts the entry and reports consumed=true for the first qualifying (matching band, points > 0) entry', () => {
    const dormant = { targetBand: 'u16' as const, bonusPoints: 100 };
    const result = applyGraduationCarryover(45, 'u16', dormant);
    expect(result).toEqual({ points: 145, consumed: true });
  });

  it('is a pure function — never mutates the dormant bonus object it was given', () => {
    const dormant = { targetBand: 'u16' as const, bonusPoints: 100 };
    const frozen = Object.freeze({ ...dormant });
    expect(() => applyGraduationCarryover(45, 'u16', frozen)).not.toThrow();
  });
});
