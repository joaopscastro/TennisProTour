import { PlayerId, RankingCalculationService, RankingLedgerEntry, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, RankingLedgerRepository } from '../ports/ports';

export interface RankedPlayer {
  playerId: PlayerId;
  totalPoints: number;
}

/**
 * The cross-player rank-position read query — deliberately not
 * something any single Player (or the old PlayerRanking aggregate it
 * replaces) could ever compute alone, since a rank only means
 * something relative to every other player's current total. Lives in
 * the application layer as a read-only query built from ports only
 * (RankingLedgerRepository, GameWorldRepository) — no framework/DB
 * import, so it's unit-testable with the same in-memory fakes every
 * use case in this package already uses, unlike the Drizzle-specific
 * read models under apps/api that go straight to raw SQL.
 *
 * Groups the full ranking_ledger by player and runs each group through
 * RankingCalculationService against the game-world's current week, so
 * "rank #4" always reflects the live 52-week/best-18 computation,
 * never a stale stored total.
 */
export class RankPositionQuery {
  constructor(
    private readonly rankingLedger: RankingLedgerRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
    private readonly calculator: RankingCalculationService = new RankingCalculationService(),
  ) {}

  /** Every player who has ever earned a ledger entry, sorted by their
   * currently-computed ranking total descending. A player with no
   * ledger entries at all doesn't appear here — that's "unranked,"
   * distinct from a player whose entries have all aged out of the
   * 52-week window (they appear, with 0 points). */
  async sortedRankings(): Promise<RankedPlayer[]> {
    const world = await this.worlds.findById(this.worldId);
    // Falls back to week 1 of season 1 if the world clock hasn't been
    // initialized yet (e.g. a fresh dev DB before the worker's first
    // tick) — matches GameWorld.create's own starting week, so ranking
    // reads never hard-fail just because the weekly-tick job hasn't
    // run yet.
    const currentWeek = world?.currentWeek ?? { season: 1, week: 1 };

    const entries = await this.rankingLedger.findAll();
    const entriesByPlayer = new Map<PlayerId, RankingLedgerEntry[]>();
    for (const entry of entries) {
      const existing = entriesByPlayer.get(entry.playerId);
      if (existing) existing.push(entry);
      else entriesByPlayer.set(entry.playerId, [entry]);
    }

    const ranked: RankedPlayer[] = [...entriesByPlayer.entries()].map(([playerId, playerEntries]) => ({
      playerId,
      totalPoints: this.calculator.calculateTotal(playerEntries, currentWeek),
    }));

    return ranked.sort((a, b) => b.totalPoints - a.totalPoints);
  }

  /** 1-indexed rank position and current total for one player; null
   * rank means unranked (no ledger entries at all), not rank 0. */
  async rankFor(playerId: PlayerId): Promise<{ totalPoints: number; rank: number | null }> {
    const sorted = await this.sortedRankings();
    const index = sorted.findIndex((r) => r.playerId === playerId);
    return {
      totalPoints: index === -1 ? 0 : sorted[index].totalPoints,
      rank: index === -1 ? null : index + 1,
    };
  }
}
