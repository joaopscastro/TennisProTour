import { describe, expect, it } from 'vitest';
import { parseArgs } from './soakTick';

/**
 * `--tick-interval-ms` is the H2 fix's entry point: it is how the
 * agent-season harness threads a COMPRESSED game-day length into the day
 * tick's match sweep, so every match's staggered reveal
 * (`scheduled_start_at` + `reveal_seconds`) lands inside its own game day
 * instead of the production 24h fallback. Left unset (every existing
 * caller), behaviour must be byte-identical to before: `null`, which the
 * handler maps back to the 24h default.
 */
describe('soakTick.parseArgs', () => {
  it('defaults tickIntervalMs to null (the production 24h day window)', () => {
    expect(parseArgs([])).toEqual({ ticks: 1, startIndex: 0, tickIntervalMs: null });
    expect(parseArgs(['--ticks', '1', '--start', '77'])).toEqual({ ticks: 1, startIndex: 77, tickIntervalMs: null });
  });

  it('parses a positive --tick-interval-ms alongside --ticks/--start', () => {
    expect(parseArgs(['--ticks', '1', '--start', '84', '--tick-interval-ms', '10000'])).toEqual({
      ticks: 1,
      startIndex: 84,
      tickIntervalMs: 10_000,
    });
  });

  it('rejects a non-positive or non-numeric --tick-interval-ms rather than silently falling back', () => {
    expect(() => parseArgs(['--tick-interval-ms', '0'])).toThrow(/positive number/);
    expect(() => parseArgs(['--tick-interval-ms', '-5'])).toThrow(/positive number/);
    expect(() => parseArgs(['--tick-interval-ms', 'soon'])).toThrow(/positive number/);
  });

  it('still rejects bad --ticks/--start values', () => {
    expect(() => parseArgs(['--ticks', '0'])).toThrow(/--ticks/);
    expect(() => parseArgs(['--start', '-1'])).toThrow(/--start/);
  });
});
