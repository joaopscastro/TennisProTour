import { eq } from 'drizzle-orm';
import { Group, MastersCup, PairId, PlayerId, Surface, TournamentId } from '@tennis-manager/domain';
import { BracketRound, TournamentDoublesPair } from '@tennis-manager/domain';
import { MastersCupRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { mastersCups } from '../../db/schema';

type Row = typeof mastersCups.$inferSelect;

/** Drizzle-backed MastersCupRepository (P8b). The whole aggregate is
 * read/written whole (one cup per season); its group stage + knockout are
 * stored as jsonb (see the schema's mastersCups doc comment). */
export class DrizzleMastersCupRepository implements MastersCupRepository {
  constructor(private readonly db: Db) {}

  async findBySeason(season: number): Promise<MastersCup | null> {
    const rows = await this.db.select().from(mastersCups).where(eq(mastersCups.season, season)).limit(1);
    if (rows.length === 0) return null;
    return toDomain(rows[0]);
  }

  async save(cup: MastersCup): Promise<void> {
    const row = {
      id: cup.id,
      season: cup.season,
      weekScheduledSeason: cup.weekScheduled.season,
      weekScheduledWeek: cup.weekScheduled.week,
      surface: cup.surface,
      singlesEntrants: [...cup.singlesEntrants],
      doublesEntrants: cup.doublesEntrants.map((p) => ({
        pairId: p.pairId,
        playerA: p.playerA,
        playerB: p.playerB,
        chemistry: p.chemistry ?? 0,
        persistentPairId: p.persistentPairId,
      })),
      singlesGroups: [...cup.singlesGroups],
      doublesGroups: [...cup.doublesGroups],
      singlesKnockout: [...cup.singlesKnockout],
      doublesKnockout: [...cup.doublesKnockout],
    };
    await this.db
      .insert(mastersCups)
      .values(row)
      .onConflictDoUpdate({ target: mastersCups.id, set: { ...row, updatedAt: new Date() } });
  }
}

function toDomain(row: Row): MastersCup {
  return MastersCup.reconstitute({
    id: TournamentId(row.id),
    season: row.season,
    weekScheduled: { season: row.weekScheduledSeason, week: row.weekScheduledWeek },
    surface: row.surface as Surface,
    singlesEntrants: row.singlesEntrants.map(PlayerId),
    doublesEntrants: row.doublesEntrants.map(
      (p): TournamentDoublesPair => ({
        pairId: PairId(p.pairId),
        playerA: PlayerId(p.playerA),
        playerB: PlayerId(p.playerB),
        chemistry: p.chemistry,
        persistentPairId: p.persistentPairId ? PairId(p.persistentPairId) : undefined,
      }),
    ),
    singlesGroups: row.singlesGroups as Group<PlayerId>[],
    doublesGroups: row.doublesGroups as Group<PairId>[],
    singlesKnockoutRounds: row.singlesKnockout as BracketRound<PlayerId>[],
    doublesKnockoutRounds: row.doublesKnockout as BracketRound<PairId>[],
  });
}
