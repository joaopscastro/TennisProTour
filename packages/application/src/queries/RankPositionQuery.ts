import {
  bestResultsCapFor,
  matchesRankingBand,
  PlayerId,
  RankingBand,
  RankingCalculationService,
  RankingLedgerEntry,
  WorldId,
} from '@tennis-manager/domain';
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
 * One instance is scoped to exactly one `RankingBand` ('senior', 'u14',
 * or 'u16') — a player's U14 results never feed their U16 total or the
 * senior total, and vice versa, because this query only ever sees the
 * ledger slice `matchesRankingBand` lets through before anything is
 * grouped or summed. `calculator` defaults to the real best-N rule for
 * that band (18 for senior, 6 for either junior band — see
 * `bestResultsCapFor`), so a caller only has to override it in tests
 * that want to assert on the cap explicitly.
 *
 * Groups that ledger slice by player and runs each group through
 * RankingCalculationService against the game-world's current week, so
 * "rank #4" always reflects the live rolling computation, never a
 * stale stored total.
 */
export class RankPositionQuery {
  constructor(
    private readonly rankingLedger: RankingLedgerRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
    private readonly band: RankingBand,
    private readonly calculator: RankingCalculationService = new RankingCalculationService(bestResultsCapFor(band)),
  ) {}

  /** Every player who currently has at least one qualifying result in
   * this band — a ledger entry within the rolling window that actually
   * contributes positive points — sorted by their currently-computed
   * ranking total descending. A ranking must be earned, not granted:
   * a player who has only ever lost in the first round (0 points every
   * time — see StandardRankingPointsTable), whose only results have
   * aged out of the rolling window, or who has never played a
   * tournament in this band at all, is genuinely unranked ("NR") and
   * does not appear here — never sorted to the bottom at an implicit
   * 0. Since no tier's non-zero-roundsWon points value is ever 0,
   * "totalPoints > 0" and "has at least one qualifying result" are the
   * same condition. */
  async sortedRankings(): Promise<RankedPlayer[]> {
    const world = await this.worlds.findById(this.worldId);
    // Falls back to week 1 of season 1 if the world clock hasn't been
    // initialized yet (e.g. a fresh dev DB before the worker's first
    // tick) — matches GameWorld.create's own starting week, so ranking
    // reads never hard-fail just because the weekly-tick job hasn't
    // run yet.
    const currentWeek = world?.currentWeek ?? { season: 1, week: 1 };

    const entries = await this.rankingLedger.findAll();
    const bandEntries = entries.filter((entry) => matchesRankingBand(entry.ageBand, this.band));

    const entriesByPlayer = new Map<PlayerId, RankingLedgerEntry[]>();
    for (const entry of bandEntries) {
      const existing = entriesByPlayer.get(entry.playerId);
      if (existing) existing.push(entry);
      else entriesByPlayer.set(entry.playerId, [entry]);
    }

    const ranked: RankedPlayer[] = [...entriesByPlayer.entries()]
      .map(([playerId, playerEntries]) => ({
        playerId,
        totalPoints: this.calculator.calculateTotal(playerEntries, currentWeek),
      }))
      .filter((r) => r.totalPoints > 0);

    return ranked.sort((a, b) => b.totalPoints - a.totalPoints);
  }

  /** 1-indexed rank position and current total for one player in this
   * band; null rank means unranked ("NR" — no qualifying result in
   * this band), not rank 0. */
  async rankFor(playerId: PlayerId): Promise<{ totalPoints: number; rank: number | null }> {
    const sorted = await this.sortedRankings();
    const index = sorted.findIndex((r) => r.playerId === playerId);
    return {
      totalPoints: index === -1 ? 0 : sorted[index].totalPoints,
      rank: index === -1 ? null : index + 1,
    };
  }
}
