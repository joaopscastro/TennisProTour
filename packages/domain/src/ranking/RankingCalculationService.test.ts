import { describe, expect, it } from 'vitest';
import { RankingCalculationService } from './RankingCalculationService';
import { RankingLedgerEntry } from './RankingLedgerEntry';
import { PlayerId, TournamentId, GameWeek } from '../shared/ids';

const player = PlayerId('p1');

function entry(overrides: Partial<RankingLedgerEntry> & { weekEarned: GameWeek; points: number }): RankingLedgerEntry {
  return {
    playerId: player,
    tournamentId: TournamentId('t'),
    tier: 'challenger',
    ageBand: null,
    ...overrides,
  };
}

describe('RankingCalculationService', () => {
  it('excludes an entry that has aged out past the 52-week rolling window', () => {
    const service = new RankingCalculationService();
    const currentWeek: GameWeek = { season: 3, week: 10 };

    // Exactly 53 weeks old (season 2, week 9 -> season 3, week 10 is
    // 53 weeks later): 2*52+9 = 113, 3*52+10 = 166, diff = 53 > 52.
    const aged = entry({ weekEarned: { season: 2, week: 9 }, points: 500 });
    // Exactly at the 52-week boundary: still counts (inclusive).
    const atBoundary = entry({ weekEarned: { season: 2, week: 10 }, points: 300 });

    expect(service.calculateTotal([aged], currentWeek)).toBe(0);
    expect(service.calculateTotal([atBoundary], currentWeek)).toBe(300);
  });

  it('caps non-major results at the best 18, excluding a 19th result', () => {
    const service = new RankingCalculationService();
    const currentWeek: GameWeek = { season: 1, week: 1 };

    // 19 challenger-tier results, each worth 100, 99, 98, ... down to 82
    // (strictly decreasing so the "excluded" one is unambiguous).
    const entries: RankingLedgerEntry[] = Array.from({ length: 19 }, (_, i) =>
      entry({ weekEarned: currentWeek, points: 100 - i, tournamentId: TournamentId(`t${i}`) }),
    );

    const total = service.calculateTotal(entries, currentWeek);
    const expectedTotal = entries
      .map((e) => e.points)
      .sort((a, b) => b - a)
      .slice(0, 18)
      .reduce((sum, p) => sum + p, 0);

    expect(total).toBe(expectedTotal);
    // The worst (19th, 82 points) result is excluded from the sum.
    expect(total).not.toBe(expectedTotal + 82);
  });

  it('counts a major-tier result even when it would not make a non-mandatory best-18 cut alone', () => {
    const service = new RankingCalculationService();
    const currentWeek: GameWeek = { season: 1, week: 1 };

    // 18 challenger results all worth more than the major result,
    // already filling the best-18 cap on their own by points.
    const strongNonMajors: RankingLedgerEntry[] = Array.from({ length: 18 }, (_, i) =>
      entry({ weekEarned: currentWeek, points: 2000, tournamentId: TournamentId(`t${i}`) }),
    );
    const weakMajor = entry({ weekEarned: currentWeek, points: 50, tier: 'major', tournamentId: TournamentId('major1') });

    const total = service.calculateTotal([...strongNonMajors, weakMajor], currentWeek);

    // The major always counts, on points alone it would never make an
    // 18-slot cut ranked purely by score — but it still occupies one of
    // the 18 slots rather than sitting outside the cap entirely, so
    // exactly one of the 18 (equally-ranked) non-majors is displaced.
    expect(total).toBe(17 * 2000 + 50);
  });

  it('accepts bestResultsCap as a constructor parameter — the real ITF best-6 junior rule is this same service reused, not a second implementation', () => {
    const juniorService = new RankingCalculationService(6);
    const currentWeek: GameWeek = { season: 1, week: 1 };

    // 7 results, each worth 100, 99, ... down to 94 — the same shape as
    // the best-18 test above, just with a smaller N.
    const entries: RankingLedgerEntry[] = Array.from({ length: 7 }, (_, i) =>
      entry({ weekEarned: currentWeek, points: 100 - i, tournamentId: TournamentId(`t${i}`) }),
    );

    const total = juniorService.calculateTotal(entries, currentWeek);
    const expectedTotal = entries
      .map((e) => e.points)
      .sort((a, b) => b - a)
      .slice(0, 6)
      .reduce((sum, p) => sum + p, 0);

    expect(total).toBe(expectedTotal);
    // The worst (7th, 94 points) result is excluded from the sum.
    expect(total).not.toBe(expectedTotal + 94);
  });

  it('defaults to the senior tour best-18 cap when constructed with no argument', () => {
    const service = new RankingCalculationService();
    const currentWeek: GameWeek = { season: 1, week: 1 };
    const entries: RankingLedgerEntry[] = Array.from({ length: 19 }, (_, i) =>
      entry({ weekEarned: currentWeek, points: 100 - i, tournamentId: TournamentId(`t${i}`) }),
    );

    // Same as "caps non-major results at the best 18" above, asserted
    // here specifically as a default-parameter regression guard.
    const total = service.calculateTotal(entries, currentWeek);
    expect(total).toBe(
      entries
        .map((e) => e.points)
        .sort((a, b) => b - a)
        .slice(0, 18)
        .reduce((sum, p) => sum + p, 0),
    );
  });

  it('lets a mandatory-skip zero (obligatory: true, 0 points) burn a best-18 slot — the punitive core of the obligatory rule', () => {
    const service = new RankingCalculationService();
    const currentWeek: GameWeek = { season: 1, week: 1 };

    // 18 strong non-major results already filling the cap on points.
    const strongNonMajors: RankingLedgerEntry[] = Array.from({ length: 18 }, (_, i) =>
      entry({ weekEarned: currentWeek, points: 500, tournamentId: TournamentId(`t${i}`) }),
    );
    const skipZero = entry({
      weekEarned: currentWeek,
      points: 0,
      tier: 'major',
      obligatory: true,
      tournamentId: TournamentId('skipped-slam'),
    });

    const withoutSkip = service.calculateTotal(strongNonMajors, currentWeek);
    const withSkip = service.calculateTotal([...strongNonMajors, skipZero], currentWeek);

    // The skip is a major-tier (obligatory) entry, so it always occupies
    // a slot — pushing exactly one 500-point non-major out of the best-18
    // and contributing 0 itself. The total drops by exactly one result.
    expect(withoutSkip).toBe(18 * 500);
    expect(withSkip).toBe(17 * 500);
  });

  it('caps obligatory results at best-N too — more mandatory results than N can never exceed the cap', () => {
    const service = new RankingCalculationService();
    const currentWeek: GameWeek = { season: 1, week: 1 };

    // 20 major-tier (obligatory) results, 100 points each — MORE than the
    // best-18 cap. They still occupy slots (can't be displaced by optional
    // results) but the total must be capped at 18 × 100, not 20 × 100.
    const majors: RankingLedgerEntry[] = Array.from({ length: 20 }, (_, i) =>
      entry({ weekEarned: currentWeek, points: 100, tier: 'major', tournamentId: TournamentId(`m${i}`) }),
    );

    expect(service.calculateTotal(majors, currentWeek)).toBe(18 * 100);

    // A 0-point skip-zero among a >N obligatory bucket does NOT add an extra
    // slot beyond the cap; the top N obligatory by points win the slots.
    const withSkipZero = service.calculateTotal(
      [...majors, entry({ weekEarned: currentWeek, points: 0, tier: 'major', obligatory: true, tournamentId: TournamentId('skip') })],
      currentWeek,
    );
    expect(withSkipZero).toBe(18 * 100);
  });
});
