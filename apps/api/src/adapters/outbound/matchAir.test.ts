import { describe, expect, it } from 'vitest';
import { isMatchAired, matchState } from './matchAir';

/**
 * The server-side air predicate is the SQL/query twin of the web
 * `lib/matchAir.ts` rule: an undecided match is `upcoming`; a decided match
 * with no schedule is `aired`; otherwise the reveal window decides. Pinned
 * here so the profile strip, the tournament history and the signing
 * commitment predicate can never silently diverge from what the UI shows.
 */
describe('matchAir (server twin of apps/web/lib/matchAir.ts)', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const at = (iso: string | null, revealSeconds = 900) => ({
    winnerId: 'w',
    scheduledStartAt: iso === null ? null : new Date(iso),
    revealSeconds,
  });

  it('an undecided match is upcoming, never aired', () => {
    expect(matchState({ winnerId: null, scheduledStartAt: null, revealSeconds: 0 }, now)).toBe('upcoming');
    expect(matchState({ winnerId: null, scheduledStartAt: new Date('2026-01-01T11:00:00Z'), revealSeconds: 900 }, now)).toBe('upcoming');
    expect(isMatchAired({ winnerId: null, scheduledStartAt: null, revealSeconds: 0 }, now)).toBe(false);
  });

  it('a decided match before its reveal is upcoming', () => {
    expect(matchState(at('2026-01-01T13:00:00Z'), now)).toBe('upcoming');
    expect(isMatchAired(at('2026-01-01T13:00:00Z'), now)).toBe(false);
  });

  it('a decided match inside its reveal window is live', () => {
    expect(matchState(at('2026-01-01T11:55:00Z'), now)).toBe('live');
    expect(isMatchAired(at('2026-01-01T11:55:00Z'), now)).toBe(false);
  });

  it('a decided match past its reveal window (or with no schedule) is aired', () => {
    expect(matchState(at('2026-01-01T11:00:00Z'), now)).toBe('aired');
    expect(isMatchAired(at('2026-01-01T11:00:00Z'), now)).toBe(true);
    expect(matchState(at(null), now)).toBe('aired');
    expect(isMatchAired(at(null), now)).toBe(true);
  });
});
