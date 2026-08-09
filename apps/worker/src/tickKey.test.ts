import { describe, expect, it } from 'vitest';
import { intervalTickKey, isoWeekTickKey } from './tickKey';

describe('isoWeekTickKey', () => {
  it('produces the same key for every moment within one real ISO week', () => {
    const monday = new Date('2026-01-05T00:00:01.000Z');
    const sunday = new Date('2026-01-11T23:59:59.000Z');
    expect(isoWeekTickKey(monday)).toBe(isoWeekTickKey(sunday));
  });

  it('produces a different key for the following ISO week', () => {
    const week1 = new Date('2026-01-05T00:00:00.000Z');
    const week2 = new Date('2026-01-12T00:00:00.000Z');
    expect(isoWeekTickKey(week1)).not.toBe(isoWeekTickKey(week2));
  });
});

describe('intervalTickKey', () => {
  it('produces the same key for two moments inside the same interval bucket', () => {
    const start = new Date('2026-01-05T00:00:00.000Z');
    const stillWithinHour = new Date('2026-01-05T00:59:59.000Z');
    const oneHourMs = 3_600_000;
    expect(intervalTickKey(start, oneHourMs)).toBe(intervalTickKey(stillWithinHour, oneHourMs));
  });

  it('produces a different key once the interval elapses — the exact bug this exists to avoid: a fast dev tick must not collapse into isoWeekTickKey\'s one-key-per-real-week bucket', () => {
    const oneHourMs = 3_600_000;
    const first = new Date('2026-01-05T00:00:00.000Z');
    const nextHour = new Date('2026-01-05T01:00:00.000Z');
    expect(intervalTickKey(first, oneHourMs)).not.toBe(intervalTickKey(nextHour, oneHourMs));
    // Both firings land in the same real ISO week, where isoWeekTickKey
    // alone would have produced an identical key and silently no-op'd
    // the second tick.
    expect(isoWeekTickKey(first)).toBe(isoWeekTickKey(nextHour));
  });
});
