import { and, eq } from 'drizzle-orm';
import { DoublesPeakRankingEntry, PlayerId, RankingBand } from '@tennis-manager/domain';
import { DoublesPeakRankingRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { doublesPeakRankings } from '../../db/schema';

type Row = typeof doublesPeakRankings.$inferSelect;

/** Drizzle-backed DoublesPeakRankingRepository (P7c) — one row per
 * (player, band), upserted in place, never append-only (the doubles
 * analogue of DrizzlePeakRankingRepository). */
export class DrizzleDoublesPeakRankingRepository implements DoublesPeakRankingRepository {
  constructor(private readonly db: Db) {}

  async findOne(playerId: PlayerId, band: RankingBand): Promise<DoublesPeakRankingEntry | null> {
    const rows = await this.db
      .select()
      .from(doublesPeakRankings)
      .where(and(eq(doublesPeakRankings.playerId, playerId), eq(doublesPeakRankings.band, band)))
      .limit(1);
    if (rows.length === 0) return null;
    return toDomain(rows[0]);
  }

  async upsert(entry: DoublesPeakRankingEntry): Promise<void> {
    await this.db
      .insert(doublesPeakRankings)
      .values({
        playerId: entry.playerId,
        band: entry.band,
        peakPoints: entry.peakPoints,
        peakAsOfSeason: entry.peakAsOfWeek.season,
        peakAsOfWeek: entry.peakAsOfWeek.week,
      })
      .onConflictDoUpdate({
        target: [doublesPeakRankings.playerId, doublesPeakRankings.band],
        set: {
          peakPoints: entry.peakPoints,
          peakAsOfSeason: entry.peakAsOfWeek.season,
          peakAsOfWeek: entry.peakAsOfWeek.week,
          updatedAt: new Date(),
        },
      });
  }
}

function toDomain(row: Row): DoublesPeakRankingEntry {
  return {
    playerId: PlayerId(row.playerId),
    band: row.band as RankingBand,
    peakPoints: row.peakPoints,
    peakAsOfWeek: { season: row.peakAsOfSeason, week: row.peakAsOfWeek },
  };
}
