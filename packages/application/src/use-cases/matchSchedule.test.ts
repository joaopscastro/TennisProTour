import { describe, expect, it } from 'vitest';
import { MatchLog } from '@tennis-manager/domain';
import { MATCH_REVEAL_CAP_SECONDS, revealWindowSecondsFor, scheduledStartAtFor, scaleMatchLogToReveal } from './matchSchedule';

const baseLog: Omit<MatchLog, 'simulatedAt'> = {
  entries: [
    { offsetSeconds: 100, setNumber: 1, gamesForA: 1, gamesForB: 0, wonBy: 'A', server: 'A' },
    { offsetSeconds: 200, setNumber: 1, gamesForA: 2, gamesForB: 0, wonBy: 'A', server: 'B' },
  ],
  points: [
    { offsetSeconds: 0, setNumber: 1, gameNumber: 1, pointScoreA: '0', pointScoreB: '0', wonBy: 'A' },
    { offsetSeconds: 100, setNumber: 1, gameNumber: 1, pointScoreA: '15', pointScoreB: '0', wonBy: 'A' },
  ],
  totalDurationSeconds: 200,
};

describe('revealWindowSecondsFor', () => {
  it('divides the day window evenly among the round\'s matches so they tile it', () => {
    // 8 matches in a 1-hour day -> 450s each; 8 * 450 = 3600s (tiles exactly).
    expect(revealWindowSecondsFor(8, 3600)).toBe(450);
    // 100 matches in a 24h day -> 864s each (below the cap); tiles exactly.
    expect(revealWindowSecondsFor(100, 86400)).toBe(864);
  });

  it('caps a sparse round so a lone match never drags for a full day', () => {
    expect(revealWindowSecondsFor(1, 86400)).toBe(MATCH_REVEAL_CAP_SECONDS);
    expect(revealWindowSecondsFor(2, 86400)).toBe(MATCH_REVEAL_CAP_SECONDS);
  });

  it('never returns less than 1 second', () => {
    expect(revealWindowSecondsFor(1000, 60)).toBeGreaterThanOrEqual(1);
  });
});

describe('scheduledStartAtFor', () => {
  it('staggers matches by the reveal window from the anchor', () => {
    const anchor = 1_700_000_000_000;
    const reveal = 450;
    const t0 = new Date(scheduledStartAtFor(0, reveal, anchor)).getTime();
    const t1 = new Date(scheduledStartAtFor(1, reveal, anchor)).getTime();
    const t3 = new Date(scheduledStartAtFor(3, reveal, anchor)).getTime();
    expect(t1 - t0).toBe(reveal * 1000);
    expect(t3 - t0).toBe(3 * reveal * 1000);
  });
});

describe('scaleMatchLogToReveal', () => {
  it('compresses a long match so its whole content unfolds over the reveal window', () => {
    const reveal = 450;
    const scaled = scaleMatchLogToReveal(baseLog, reveal);
    expect(scaled.totalDurationSeconds).toBe(reveal);
    expect(scaled.entries).toHaveLength(baseLog.entries.length);
    expect(scaled.points).toHaveLength(baseLog.points.length);
    const factor = reveal / 200;
    expect(scaled.entries[1].offsetSeconds).toBe(Math.round(200 * factor));
    expect(scaled.entries[1].offsetSeconds).toBeLessThanOrEqual(reveal);
    expect(scaled.entries[1].offsetSeconds).toBeGreaterThanOrEqual(scaled.entries[0].offsetSeconds);
    expect(scaled.points[1].offsetSeconds).toBeGreaterThanOrEqual(scaled.points[0].offsetSeconds);
  });

  it('expands a short match to fill the reveal window', () => {
    const reveal = 1000;
    const scaled = scaleMatchLogToReveal({ ...baseLog, totalDurationSeconds: 100 }, reveal);
    expect(scaled.totalDurationSeconds).toBe(1000);
    expect(scaled.entries[1].offsetSeconds).toBeGreaterThan(scaled.entries[0].offsetSeconds);
  });

  it('is a no-op when the log has no duration', () => {
    const scaled = scaleMatchLogToReveal({ ...baseLog, totalDurationSeconds: 0 }, 450);
    expect(scaled).toEqual({ ...baseLog, totalDurationSeconds: 0 });
  });
});
