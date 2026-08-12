import { describe, expect, it } from 'vitest';
import { intervalTickKey, isoWeekTickKey, isoDayTickKey } from './tickKey';

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

describe('isoDayTickKey', () => {
  it('produces the same key for every moment within one real UTC day', () => {
    const morning = new Date('2026-01-05T00:00:01.000Z');
    const night = new Date('2026-01-05T23:59:59.000Z');
    expect(isoDayTickKey(morning)).toBe(isoDayTickKey(night));
  });

  it('produces a different key for the following UTC day', () => {
    const day1 = new Date('2026-01-05T12:00:00.000Z');
    const day2 = new Date('2026-01-06T12:00:00.000Z');
    expect(isoDayTickKey(day1)).not.toBe(isoDayTickKey(day2));
  });

  it('advances every day of a real week (the whole point of the day tick — isoWeekTickKey would collapse all 7)', () => {
    const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'].map(
      (d) => new Date(`${d}T09:00:00.000Z`),
    );
    const keys = new Set(days.map(isoDayTickKey));
    expect(keys.size).toBe(7); // 7 distinct day keys
    // ...whereas isoWeekTickKey collapses the same 7 days to a single key.
    expect(new Set(days.map(isoWeekTickKey)).size).toBe(1);
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
