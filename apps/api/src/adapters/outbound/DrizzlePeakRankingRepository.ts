import { and, eq } from 'drizzle-orm';
import { PeakRankingEntry, PlayerId, RankingBand } from '@tennis-manager/domain';
import { PeakRankingRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { peakRankings } from '../../db/schema';

/**
 * The mutable high-water-mark store — see peakRankings' own schema
 * doc comment for why upsert() targets the composite (player_id,
 * band) primary key instead of ever inserting a second row.
 */
export class DrizzlePeakRankingRepository implements PeakRankingRepository {
  constructor(private readonly db: Db) {}

  async findOne(playerId: PlayerId, band: RankingBand): Promise<PeakRankingEntry | null> {
    const rows = await this.db
      .select()
      .from(peakRankings)
      .where(and(eq(peakRankings.playerId, playerId), eq(peakRankings.band, band)))
      .limit(1);
    if (rows.length === 0) return null;
    return toPeakRankingEntry(rows[0]);
  }

  async upsert(entry: PeakRankingEntry): Promise<void> {
    const row: typeof peakRankings.$inferInsert = {
      playerId: entry.playerId,
      band: entry.band,
      peakPoints: entry.peakPoints,
      peakAsOfSeason: entry.peakAsOfWeek.season,
      peakAsOfWeek: entry.peakAsOfWeek.week,
    };
    await this.db
      .insert(peakRankings)
      .values(row)
      .onConflictDoUpdate({
        target: [peakRankings.playerId, peakRankings.band],
        set: { peakPoints: row.peakPoints, peakAsOfSeason: row.peakAsOfSeason, peakAsOfWeek: row.peakAsOfWeek, updatedAt: new Date() },
      });
  }

  async findAllForPlayer(playerId: PlayerId): Promise<PeakRankingEntry[]> {
    const rows = await this.db.select().from(peakRankings).where(eq(peakRankings.playerId, playerId));
    return rows.map(toPeakRankingEntry);
  }
}

function toPeakRankingEntry(row: typeof peakRankings.$inferSelect): PeakRankingEntry {
  return {
    playerId: PlayerId(row.playerId),
    band: row.band as RankingBand,
    peakPoints: row.peakPoints,
    peakAsOfWeek: { season: row.peakAsOfSeason, week: row.peakAsOfWeek },
  };
}
