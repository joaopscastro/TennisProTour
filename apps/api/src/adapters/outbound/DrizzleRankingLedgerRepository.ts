import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PlayerId, RankingLedgerEntry, TournamentId } from '@tennis-manager/domain';
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
      points: entry.points,
      seasonEarned: entry.weekEarned.season,
      weekEarned: entry.weekEarned.week,
    });
  }

  async findByPlayer(playerId: PlayerId): Promise<RankingLedgerEntry[]> {
    const rows = await this.db.select().from(rankingLedger).where(eq(rankingLedger.playerId, playerId));
    return rows.map((row) => ({
      playerId: PlayerId(row.playerId),
      tournamentId: TournamentId(row.tournamentId),
      tier: row.tier,
      points: row.points,
      weekEarned: { season: row.seasonEarned, week: row.weekEarned },
    }));
  }
}
