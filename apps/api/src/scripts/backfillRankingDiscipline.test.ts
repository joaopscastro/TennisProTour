import { describe, expect, it } from 'vitest';
import { GameWeek, PairId, PlayerId, TournamentId } from '@tennis-manager/domain';
import {
  BackfillInput,
  buildExpectedDoublesAwards,
  buildExpectedCupAwards,
  buildExpectedSinglesAwards,
  classifyGroup,
  classifyLedgerDiscipline,
  diffPeaks,
  recomputePeaks,
  runBackfill,
} from './backfillRankingDiscipline';
import type { DoublesMatchInput, LedgerRowInput, SinglesMatchInput, TournamentInput } from './backfillRankingDiscipline';

const T = 't1';

function tournament(tier: TournamentInput['tier'], ageBand: TournamentInput['ageBand'] = null): TournamentInput {
  return { id: T, tier, ageBand };
}

function singlesMatch(roundNumber: number, winnerId: string, loserId: string, draw: SinglesMatchInput['draw'] = 'main'): SinglesMatchInput {
  return { tournamentId: T, draw, roundNumber, winnerId, loserId };
}

function doublesMatch(
  roundNumber: number,
  entrantA: string,
  entrantB: string,
  winnerId: string,
  loserId: string,
): DoublesMatchInput {
  return { tournamentId: T, draw: 'main', roundNumber, entrantA, entrantB, winnerId, loserId };
}

function row(id: string, playerId: string, points: number, obligatory = false): LedgerRowInput {
  return { id, playerId, tournamentId: T, points, obligatory };
}

describe('buildExpectedSinglesAwards', () => {
  it('pays an eliminating loser the rounds-won value and the main-draw final winner the champion value', () => {
    // A tiny 4-entrant bracket: R1 has two matches, R2 is the final.
    const matches: SinglesMatchInput[] = [
      singlesMatch(1, 'a', 'b'),
      singlesMatch(1, 'c', 'd'),
      singlesMatch(2, 'a', 'c'),
    ];
    const expected = buildExpectedSinglesAwards([tournament('challenger')], matches);

    // b and d lost R1 (0 wins); c lost the final (1 win); a won the final.
    expect(expected.get(`${T}|b`)).toEqual([0]);
    expect(expected.get(`${T}|d`)).toEqual([0]);
    expect(expected.get(`${T}|c`)).toEqual([50]);
    expect(expected.get(`${T}|a`)).toEqual([100]);
  });

  it('pays qualifying eliminations from the qualifying table and no winner award from a completed qualifying draw', () => {
    const matches: SinglesMatchInput[] = [
      singlesMatch(1, 'a', 'b', 'qualifying'),
      singlesMatch(1, 'c', 'd', 'qualifying'),
      singlesMatch(2, 'a', 'c', 'qualifying'),
    ];
    const expected = buildExpectedSinglesAwards([tournament('challenger')], matches);

    expect(expected.get(`${T}|b`)).toEqual([0]);
    expect(expected.get(`${T}|d`)).toEqual([0]);
    // c won one qualifying round before losing the last one → index 1.
    expect(expected.get(`${T}|c`)).toEqual([13]);
    // The qualifying winner is promoted, never awarded from qualifying.
    expect(expected.get(`${T}|a`)).toBeUndefined();
  });
});

describe('buildExpectedDoublesAwards', () => {
  it('reproduces the historical SLOT-based assignment: entrantA gets the winner value, entrantB the loser value', () => {
    const pairs = [
      { tournamentId: T, pairId: 'd0', playerA: 'a1', playerB: 'a2' },
      { tournamentId: T, pairId: 'd1', playerA: 'b1', playerB: 'b2' },
    ];
    // d1 wins the R1 match despite being entrantB — the historical bug
    // still awards d0 (entrantA) the winner's value and d1 the loser's.
    const matches: DoublesMatchInput[] = [doublesMatch(1, 'd0', 'd1', 'd1', 'd0')];
    const expected = buildExpectedDoublesAwards([tournament('challenger')], matches, pairs);

    expect(expected.get(`${T}|a1`)).toEqual([90]);
    expect(expected.get(`${T}|a2`)).toEqual([90]);
    expect(expected.get(`${T}|b1`)).toEqual([0]);
    expect(expected.get(`${T}|b2`)).toEqual([0]);
  });

  it('keeps a running per-pair win count across rounds so a pair accumulates one row per match played', () => {
    const pairs = [
      { tournamentId: T, pairId: 'd0', playerA: 'a1', playerB: 'a2' },
      { tournamentId: T, pairId: 'd1', playerA: 'b1', playerB: 'b2' },
      { tournamentId: T, pairId: 'd2', playerA: 'c1', playerB: 'c2' },
      { tournamentId: T, pairId: 'd3', playerA: 'd1p', playerB: 'd2p' },
    ];
    const matches: DoublesMatchInput[] = [
      doublesMatch(1, 'd0', 'd1', 'd0', 'd1'),
      doublesMatch(1, 'd2', 'd3', 'd2', 'd3'),
      doublesMatch(2, 'd0', 'd2', 'd0', 'd2'),
    ];
    const expected = buildExpectedDoublesAwards([tournament('challenger')], matches, pairs);

    // d0: R1 win (90), R2 win (180) → one row per match.
    expect(expected.get(`${T}|a1`)).toEqual([90, 180]);
    // d2: R1 win (90), R2 loss (90 as it had one prior win).
    expect(expected.get(`${T}|c1`)).toEqual([90, 90]);
    // d1 lost R1 immediately: 0.
    expect(expected.get(`${T}|b1`)).toEqual([0]);
  });
});

describe('buildExpectedCupAwards', () => {
  it('awards cup knockout losers semifinalist/runner-up points and the champion the title points, scaled for doubles', () => {
    const cup = {
      id: 'cup-1',
      singlesKnockout: [
        {
          roundNumber: 1,
          matches: [
            { entrantA: PlayerId('s1'), entrantB: PlayerId('s2'), outcome: { winner: PlayerId('s1'), loser: PlayerId('s2'), setScores: [] } },
            { entrantA: PlayerId('s3'), entrantB: PlayerId('s4'), outcome: { winner: PlayerId('s3'), loser: PlayerId('s4'), setScores: [] } },
          ],
        },
        {
          roundNumber: 2,
          matches: [
            { entrantA: PlayerId('s1'), entrantB: PlayerId('s3'), outcome: { winner: PlayerId('s1'), loser: PlayerId('s3'), setScores: [] } },
          ],
        },
      ],
      doublesKnockout: [
        {
          roundNumber: 1,
          matches: [
            { entrantA: PairId('p1'), entrantB: PairId('p2'), outcome: { winner: PairId('p1'), loser: PairId('p2'), setScores: [] } },
            { entrantA: PairId('p3'), entrantB: PairId('p4'), outcome: { winner: PairId('p3'), loser: PairId('p4'), setScores: [] } },
          ],
        },
        {
          roundNumber: 2,
          matches: [
            { entrantA: PairId('p1'), entrantB: PairId('p3'), outcome: { winner: PairId('p1'), loser: PairId('p3'), setScores: [] } },
          ],
        },
      ],
      doublesEntrants: [
        { pairId: 'p1', playerA: 'da1', playerB: 'da2' },
        { pairId: 'p2', playerA: 'db1', playerB: 'db2' },
        { pairId: 'p3', playerA: 'dc1', playerB: 'dc2' },
        { pairId: 'p4', playerA: 'dd1', playerB: 'dd2' },
      ],
    };
    const awards = buildExpectedCupAwards([cup]);
    expect(awards.singles.get('cup-1|s2')).toEqual([450]);
    expect(awards.singles.get('cup-1|s3')).toEqual([900]);
    expect(awards.singles.get('cup-1|s1')).toEqual([1500]);
    expect(awards.doubles.get('cup-1|db1')).toEqual([225]);
    expect(awards.doubles.get('cup-1|da1')).toEqual([750]);
  });
});

describe('classifyGroup', () => {
  it('separates one singles row from the doubles awards by multiset assignment', () => {
    // A player who lost singles (50) and won two doubles rounds (90, 180).
    const rows = [row('s', 'p', 50), row('d1', 'p', 90), row('d2', 'p', 180)];
    const outcome = classifyGroup(T, 'p', rows, [50], [90, 180]);
    expect(outcome.doublesRowIds.sort()).toEqual(['d1', 'd2']);
    expect(outcome.unresolved).toHaveLength(0);
  });

  it('treats a row whose value EXCEEDS its computed expectation as singles (graduation carryover)', () => {
    const rows = [row('s', 'p', 150), row('d1', 'p', 90)];
    const outcome = classifyGroup(T, 'p', rows, [50], [90]);
    // 150 > the expected 50 — carryover — and removing it leaves exactly
    // the doubles multiset.
    expect(outcome.doublesRowIds).toEqual(['d1']);
    expect(outcome.unresolved).toHaveLength(0);
  });

  it('marks a tie-broken assignment but still leaves equal-value twins indistinguishable only in identity, never in totals', () => {
    const rows = [row('a', 'p', 90), row('b', 'p', 90)];
    const outcome = classifyGroup(T, 'p', rows, [90], [90]);
    expect(outcome.tieBroken).toBe(1);
    expect(outcome.doublesRowIds).toHaveLength(1);
    expect(outcome.unresolved).toHaveLength(0);
  });

  it('counts an extra row with no recomputable singles record as unverified singles, never doubles', () => {
    // One doubles award plus one row that cannot be explained by the
    // (missing) singles bracket — left singles.
    const rows = [row('d1', 'p', 90), row('s', 'p', 50)];
    const outcome = classifyGroup(T, 'p', rows, [], [90]);
    expect(outcome.doublesRowIds).toEqual(['d1']);
    expect(outcome.singlesWithoutExpectedRecord).toBe(1);
    expect(outcome.unresolved).toHaveLength(0);
  });

  it('leaves obligatory skip-zero rows as singles and never matches them against doubles awards', () => {
    const rows = [row('d1', 'p', 90), row('obl', 'p', 0, true)];
    const outcome = classifyGroup(T, 'p', rows, [], [90]);
    expect(outcome.doublesRowIds).toEqual(['d1']);
    expect(outcome.unresolved).toHaveLength(0);
  });

  it('reports a leftover whose value matches the doubles expectation as unresolved rather than guessing', () => {
    // Two rows of 90 but the recomputed doubles bracket expects 90 AND
    // 180 — no exact whole-group assignment exists, and the second 90
    // could have been the missing 180's sibling. Never guessed.
    const rows = [row('d1', 'p', 90), row('extra', 'p', 90)];
    const outcome = classifyGroup(T, 'p', rows, [], [90, 180]);
    expect(outcome.doublesRowIds).toHaveLength(1);
    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0].points).toBe(90);
    expect(outcome.missingExpectedDoubles).toBe(1);
  });
});

describe('recomputePeaks', () => {
  function peakEntry(playerId: string, discipline: 'singles' | 'doubles', points: number, week: GameWeek) {
    return {
      id: `${playerId}-${discipline}-${points}-${week.season}-${week.week}`,
      playerId: PlayerId(playerId),
      tournamentId: TournamentId('t'),
      tier: 'challenger' as const,
      ageBand: null,
      band: 'senior' as const,
      discipline,
      points,
      weekEarned: week,
    };
  }

  it('replays each scope week by week and keeps the highest rolling total (expiry can only lower it)', () => {
    // Week 1: 100. Week 2: 60 → total 160. Week 60: 100+60 have aged out
    // (window 52), only a fresh 80 remains → 80. Peak stays 160.
    const records = recomputePeaks(
      [
        peakEntry('p', 'singles', 100, { season: 1, week: 1 }),
        peakEntry('p', 'singles', 60, { season: 1, week: 2 }),
        peakEntry('p', 'singles', 80, { season: 2, week: 8 }),
      ],
      52,
    );
    expect(records).toEqual([
      { playerId: 'p', band: 'senior', discipline: 'singles', peakPoints: 160, peakAsOfWeek: { season: 1, week: 2 } },
    ]);
  });

  it('keeps singles and doubles in SEPARATE scopes — a doubles row can never feed a singles peak', () => {
    const records = recomputePeaks(
      [peakEntry('p', 'singles', 100, { season: 1, week: 1 }), peakEntry('p', 'doubles', 500, { season: 1, week: 1 })],
      52,
    );
    const singles = records.find((r) => r.discipline === 'singles');
    const doubles = records.find((r) => r.discipline === 'doubles');
    expect(singles?.peakPoints).toBe(100);
    expect(doubles?.peakPoints).toBe(500);
  });
});

describe('diffPeaks', () => {
  it('counts creates, raises, lowers, unchanged rows and removals of scopes with no entries', () => {
    const records = [
      { playerId: 'create', band: 'senior' as const, discipline: 'singles' as const, peakPoints: 10, peakAsOfWeek: { season: 1, week: 1 } },
      { playerId: 'raise', band: 'senior' as const, discipline: 'singles' as const, peakPoints: 200, peakAsOfWeek: { season: 1, week: 1 } },
      { playerId: 'lower', band: 'senior' as const, discipline: 'singles' as const, peakPoints: 5, peakAsOfWeek: { season: 1, week: 1 } },
      { playerId: 'same', band: 'senior' as const, discipline: 'singles' as const, peakPoints: 50, peakAsOfWeek: { season: 1, week: 1 } },
    ];
    const stored = [
      { playerId: 'raise', band: 'senior' as const, peakPoints: 100 },
      { playerId: 'lower', band: 'senior' as const, peakPoints: 500 },
      { playerId: 'same', band: 'senior' as const, peakPoints: 50 },
      { playerId: 'gone', band: 'senior' as const, peakPoints: 999 },
    ];
    expect(diffPeaks(records, stored)).toEqual({ create: 1, raise: 1, lower: 1, unchanged: 1, remove: 1 });
  });
});

describe('classifyLedgerDiscipline (end to end, synthetic)', () => {
  function input(overrides: Partial<BackfillInput> = {}): BackfillInput {
    return {
      ledger: [],
      tournaments: [],
      singlesMatches: [],
      doublesMatches: [],
      doublesPairs: [],
      cups: [],
      ...overrides,
    };
  }

  it('classifies a doubles row, leaves obligatory zeros alone, and reports unknown event ids as unresolved', () => {
    const pairs = [
      { tournamentId: T, pairId: 'd0', playerA: 'a1', playerB: 'a2' },
      { tournamentId: T, pairId: 'd1', playerA: 'b1', playerB: 'b2' },
    ];
    const result = classifyLedgerDiscipline(
      input({
        tournaments: [tournament('challenger')],
        ledger: [
          row('d-a1', 'a1', 90),
          row('d-a2', 'a2', 90),
          row('obl', 'a1', 0, true),
          { id: 'ghost', playerId: 'ghost', tournamentId: 'missing-event', points: 5, obligatory: false },
        ],
        doublesMatches: [doublesMatch(1, 'd0', 'd1', 'd0', 'd1')],
        doublesPairs: pairs,
      }),
    );
    expect(result.doublesRowIds.sort()).toEqual(['d-a1', 'd-a2']);
    expect(result.report.setDoubles).toBe(2);
    expect(result.report.keptSingles).toBe(2);
    expect(result.report.unresolved).toHaveLength(1);
    expect(result.report.unresolved[0].reason).toBe('unknown-event-id');
  });

  it('is deterministic: running the same input twice yields the same doubles set', () => {
    const inputA = input({
      tournaments: [tournament('challenger')],
      ledger: [row('d1', 'p', 90), row('s1', 'p', 50), row('d2', 'p', 180)],
      singlesMatches: [singlesMatch(1, 'winner', 'p')],
      doublesPairs: [
        { tournamentId: T, pairId: 'd0', playerA: 'p', playerB: 'other' },
        { tournamentId: T, pairId: 'd1', playerA: 'x', playerB: 'y' },
      ],
      doublesMatches: [doublesMatch(1, 'd0', 'd1', 'd0', 'd1'), doublesMatch(2, 'd0', 'd2x', 'd0', 'd2x')],
    });
    // Note: the second doubles match's pair ids are not in the pairs table
    // (d2x), so only the first contributes expectations.
    const first = classifyLedgerDiscipline(inputA).doublesRowIds.sort();
    const second = classifyLedgerDiscipline(inputA).doublesRowIds.sort();
    expect(second).toEqual(first);
  });
});

describe('runBackfill', () => {
  it('is exported as the CLI entry point', () => {
    expect(typeof runBackfill).toBe('function');
  });
});
