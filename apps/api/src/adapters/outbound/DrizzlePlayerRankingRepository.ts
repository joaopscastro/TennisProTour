import { desc, eq } from 'drizzle-orm';
import { PlayerId, PlayerRanking } from '@tennis-manager/domain';
import { PlayerRankingRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { playerRankings } from '../../db/schema';

export class DrizzlePlayerRankingRepository implements PlayerRankingRepository {
  constructor(private readonly db: Db) {}

  async findById(playerId: PlayerId): Promise<PlayerRanking | null> {
    const rows = await this.db.select().from(playerRankings).where(eq(playerRankings.playerId, playerId)).limit(1);
    if (rows.length === 0) return null;
    return PlayerRanking.reconstitute({
      playerId: PlayerId(rows[0].playerId),
      totalPoints: rows[0].totalPoints,
    });
  }

  async save(ranking: PlayerRanking): Promise<void> {
    const row = {
      playerId: ranking.playerId,
      totalPoints: ranking.totalPoints,
    };
    await this.db
      .insert(playerRankings)
      .values(row)
      .onConflictDoUpdate({ target: playerRankings.playerId, set: { ...row, updatedAt: new Date() } });
  }

  async findAllSortedByPoints(): Promise<PlayerRanking[]> {
    const rows = await this.db.select().from(playerRankings).orderBy(desc(playerRankings.totalPoints));
    return rows.map((row) => PlayerRanking.reconstitute({ playerId: PlayerId(row.playerId), totalPoints: row.totalPoints }));
  }
}
