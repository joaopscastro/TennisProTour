import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AgeBand, PlayerId, RankingLedgerEntry, TournamentId } from '@tennis-manager/domain';
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
      seasonEarned: entry.weekEarned.season,
      weekEarned: entry.weekEarned.week,
    });
  }

  async findByPlayer(playerId: PlayerId): Promise<RankingLedgerEntry[]> {
    const rows = await this.db.select().from(rankingLedger).where(eq(rankingLedger.playerId, playerId));
    return rows.map(toRankingLedgerEntry);
  }

  async findAll(): Promise<RankingLedgerEntry[]> {
    const rows = await this.db.select().from(rankingLedger);
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
    weekEarned: { season: row.seasonEarned, week: row.weekEarned },
  };
}
