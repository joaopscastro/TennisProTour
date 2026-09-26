import { describe, expect, it } from 'vitest';
import {
  buildCandidateView,
  enterabilityBlockReason,
  tournamentConcluded,
} from './digestFeed.mjs';

/** Minimal toTournamentDto-shaped fixture; only the fields the helpers read. */
function tournament(overrides = {}) {
  return {
    id: overrides.id ?? 't1',
    name: overrides.name ?? 'Test Open',
    tier: overrides.tier ?? 'futures',
    circuit: overrides.circuit ?? 'senior',
    ageBand: overrides.ageBand ?? null,
    surface: overrides.surface ?? 'hard',
    hostCountry: overrides.hostCountry ?? 'Spain',
    weekScheduled: overrides.weekScheduled ?? { season: 1, week: 5 },
    drawSize: overrides.drawSize ?? 32,
    mainDrawEntrants: overrides.mainDrawEntrants ?? 8,
    doublesDrawSize: overrides.doublesDrawSize ?? 0,
    doublesEntrants: overrides.doublesEntrants ?? [],
    hasStarted: overrides.hasStarted ?? false,
    cancelled: overrides.cancelled ?? false,
    rounds: overrides.rounds ?? [],
    rankRestricted: overrides.rankRestricted ?? false,
    rankRestrictedReason: overrides.rankRestrictedReason ?? null,
    ...overrides,
  };
}

describe('tournamentConcluded (the pendingEntries filter)', () => {
  it('is false for a draw that has not been seeded yet (incl. still in qualifying)', () => {
    expect(tournamentConcluded(tournament({ rounds: [] }))).toBe(false);
  });

  it('is false for a seeded draw whose last round still has an undecided match', () => {
    const t = tournament({
      rounds: [
        { roundNumber: 1, matches: [{ outcome: { winner: 'a' } }] },
        { roundNumber: 2, matches: [{ outcome: null }] },
      ],
    });
    expect(tournamentConcluded(t)).toBe(false);
  });

  it('is true only once the last main round is fully decided', () => {
    const t = tournament({
      rounds: [
        { roundNumber: 1, matches: [{ outcome: { winner: 'a' } }] },
        { roundNumber: 2, matches: [{ outcome: { winner: 'a' } }] },
      ],
    });
    expect(tournamentConcluded(t)).toBe(true);
  });

  it('is true for a cancelled draw (terminal, never plays)', () => {
    expect(tournamentConcluded(tournament({ cancelled: true, rounds: [] }))).toBe(true);
  });

  it('regression: a STARTED but unfinished draw is NOT concluded (the exact old filter bug)', () => {
    // The old digest filter was `if (entry.hasStarted) continue` — by digest
    // time every tournament scheduled for the current week has started, so
    // a just-registered entry was always dropped. It must instead survive
    // until the draw CONCLUDES.
    const started = tournament({
      hasStarted: true,
      rounds: [{ roundNumber: 1, matches: [{ outcome: null }, { outcome: null }] }],
    });
    expect(started.hasStarted).toBe(true);
    expect(tournamentConcluded(started)).toBe(false);
  });
});

describe('buildCandidateView (canEnterNow)', () => {
  const currentAbs = 1 * 52 + 5; // S1W5

  it('lists rank-restricted events as disabled-with-reason instead of omitting them', () => {
    const restricted = tournament({
      id: 'restricted-1',
      name: 'Vanished Futures',
      tier: 'futures',
      rankRestricted: true,
      rankRestrictedReason: 'ranked #37 on the senior ladder — too high to enter a futures event',
    });
    const { rows, meta } = buildCandidateView([restricted], currentAbs);
    expect(rows).toHaveLength(1);
    expect(rows[0].enterable).toBe(false);
    expect(rows[0].blockedReason).toContain('too high to enter a futures event');
    expect(meta).toMatchObject({ shown: 1, enterableShown: 0, enterableTotal: 0, restrictedShown: 1, restrictedTotal: 1 });
  });

  it('always shows restricted rows even when the enterable list is already capped', () => {
    const enterable = Array.from({ length: 12 }, (_, i) =>
      tournament({ id: `open-${i}`, name: `Open ${String(i).padStart(2, '0')}` }),
    );
    const restricted = tournament({ id: 'r1', name: 'Restricted Open', rankRestricted: true, rankRestrictedReason: 'too high' });
    const { rows, meta } = buildCandidateView([...enterable, restricted], currentAbs);
    // 10 enterable shown (capped) + the restricted row appended.
    expect(rows.filter((r) => r.enterable)).toHaveLength(10);
    expect(rows.filter((r) => !r.enterable)).toHaveLength(1);
    expect(rows[rows.length - 1].id).toBe('r1');
    expect(meta).toMatchObject({ enterableShown: 10, enterableTotal: 12, restrictedShown: 1, restrictedTotal: 1, truncated: true });
  });

  it('reports truncation so a capped list is never mistaken for the whole slate', () => {
    const enterable = Array.from({ length: 3 }, (_, i) => tournament({ id: `e${i}`, name: `Event ${i}` }));
    const { meta } = buildCandidateView(enterable, currentAbs);
    expect(meta).toMatchObject({ shown: 3, enterableShown: 3, enterableTotal: 3, truncated: false });
  });

  it('still omits non-rank-restricted blocked rows (started, full, cap reached, ineligible, past)', () => {
    const rows = [
      tournament({ id: 'started', hasStarted: true }),
      tournament({ id: 'full', mainDrawEntrants: 32 }),
      tournament({ id: 'capped', weeklyEntryCountThisWeek: 1, weeklyEntryCapThisWeek: 1 }),
      tournament({ id: 'age', ageEligible: false }),
      tournament({ id: 'past', weekScheduled: { season: 1, week: 4 } }),
      tournament({ id: 'ok', name: 'Real Option' }),
    ];
    const { rows: shown } = buildCandidateView(rows, currentAbs);
    expect(shown.map((r) => r.id)).toEqual(['ok']);
  });

  it('sorts enterable candidates nearest-week first', () => {
    const rows = [
      tournament({ id: 'later', name: 'Later', weekScheduled: { season: 1, week: 8 } }),
      tournament({ id: 'sooner', name: 'Sooner', weekScheduled: { season: 1, week: 6 } }),
    ];
    const { rows: shown } = buildCandidateView(rows, currentAbs);
    expect(shown.map((r) => r.id)).toEqual(['sooner', 'later']);
  });
});

describe('enterabilityBlockReason', () => {
  it('returns a plain reason for each blocked state, null when enterable', () => {
    expect(enterabilityBlockReason(tournament({ hasStarted: true }), 57)).toBe('entries are closed');
    expect(enterabilityBlockReason(tournament({ ageEligible: false }), 57)).toBe('not age-eligible for this band');
    expect(enterabilityBlockReason(tournament({ mainDrawEntrants: 32 }), 57)).toBe('the draw is full');
    expect(enterabilityBlockReason(tournament({ weekScheduled: { season: 1, week: 1 } }), 57)).toBe('the week has already passed');
    expect(enterabilityBlockReason(tournament(), 57)).toBeNull();
  });
});
