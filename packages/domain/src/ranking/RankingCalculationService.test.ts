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
});
