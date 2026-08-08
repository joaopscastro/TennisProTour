import { describe, expect, it } from 'vitest';
import { PlayerId } from '../shared/ids';
import { isNewPeak, PeakRankingEntry } from './PeakRanking';

function peak(points: number): PeakRankingEntry {
  return { playerId: PlayerId('p1'), band: 'senior', peakPoints: points, peakAsOfWeek: { season: 1, week: 1 } };
}

describe('isNewPeak', () => {
  it('is a new peak when no peak has ever been recorded yet', () => {
    expect(isNewPeak(50, null)).toBe(true);
  });

  it('is a new peak when the fresh total exceeds the stored peak', () => {
    expect(isNewPeak(120, peak(100))).toBe(true);
  });

  it('is NOT a new peak when the fresh total is lower than the stored peak', () => {
    expect(isNewPeak(80, peak(100))).toBe(false);
  });

  it('is NOT a new peak on an exact tie — strictly greater-than, not greater-or-equal', () => {
    expect(isNewPeak(100, peak(100))).toBe(false);
  });
});
