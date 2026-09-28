import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { AgeBand, GameWeek, PlayerId, RankingLedgerEntry, TournamentId, WEEKS_PER_SEASON } from '@tennis-manager/domain';
import { RankingLedgerRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { rankingLedger } from '../../db/schema';

export class DrizzleRankingLedgerRepository implements RankingLedgerRepository {
  constructor(private readonly db: Db) {}

  async append(entry: RankingLedgerEntry): Promise<void> {
    await this.db.insert(rankingLedger).values({
      id: randomUUID(),
      playerId: entry.playerId,
      tournamentId: entry.tournamentId,
      tier: entry.tier,
      ageBand: entry.ageBand,
      points: entry.points,
      obligatory: entry.obligatory ?? false,
      // The `?? 'singles'` default is load-bearing and mirrors the
      // domain's own fallback at every read site: pre-P7b construction
      // sites omit `discipline` entirely, and those are singles results.
      discipline: entry.discipline ?? 'singles',
      seasonEarned: entry.weekEarned.season,
      weekEarned: entry.weekEarned.week,
    });
  }

  async findByPlayer(playerId: PlayerId): Promise<RankingLedgerEntry[]> {
    const rows = await this.db.select().from(rankingLedger).where(eq(rankingLedger.playerId, playerId));
    return rows.map(toRankingLedgerEntry);
  }

  async findAll(): Promise<RankingLedgerEntry[]> {
    // Ordered by player_id (determinism fix): equal totals used to keep
    // whatever order the read returned, and the cross-player rank query
    // groups entries in first-appearance order. With this and the
    // query's own playerId tiebreak, the same data always yields the
    // same standings — see RankPositionQuery.sortedRankings.
    const rows = await this.db.select().from(rankingLedger).orderBy(asc(rankingLedger.playerId));
    return rows.map(toRankingLedgerEntry);
  }

  /**
   * The windowed read — see RankingLedgerRepository.findAllWithinWindow's
   * doc comment. One SQL prefilter over the SAME absolute-week arithmetic
   * `weeksBetween` uses (`season * WEEKS_PER_SEASON + week`), inclusive
   * of both window ends (`current - weeks <= earned <= current`), so the
   * application layer never materializes or re-groups rows that could
   * not contribute a single ranking point. Byte-identical results for
   * everything inside the window; ordering matches findAll()'s own
   * player_id ordering for the same determinism reason.
   */
  async findAllWithinWindow(currentWeek: GameWeek, weeks: number): Promise<RankingLedgerEntry[]> {
    const currentAbsolute = currentWeek.season * WEEKS_PER_SEASON + currentWeek.week;
    const earliestAbsolute = currentAbsolute - weeks;
    const rows = await this.db
      .select()
      .from(rankingLedger)
      .where(
        sql`(${rankingLedger.seasonEarned} * ${WEEKS_PER_SEASON} + ${rankingLedger.weekEarned}) BETWEEN ${earliestAbsolute} AND ${currentAbsolute}`,
      )
      .orderBy(asc(rankingLedger.playerId));
    return rows.map(toRankingLedgerEntry);
  }
}

function toRankingLedgerEntry(row: typeof rankingLedger.$inferSelect): RankingLedgerEntry {
  return {
    playerId: PlayerId(row.playerId),
    tournamentId: TournamentId(row.tournamentId),
    tier: row.tier,
    ageBand: row.ageBand as AgeBand | null,
    points: row.points,
    obligatory: row.obligatory,
    // Read back explicitly rather than leaving it undefined: every row
    // now has a real value (the NOT NULL DEFAULT 'singles' is what every
    // pre-existing row reads back as), and every consumer's
    // `entry.discipline ?? 'singles'` check stays correct either way.
    discipline: row.discipline,
    weekEarned: { season: row.seasonEarned, week: row.weekEarned },
  };
}
