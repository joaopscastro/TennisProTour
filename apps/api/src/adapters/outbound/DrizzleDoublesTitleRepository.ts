import { eq, or } from 'drizzle-orm';
import { AgeBand, DoublesTitleRecord, GameWeek, PlayerId, TournamentId, TournamentTier } from '@tennis-manager/domain';
import { DoublesTitleRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { doublesTitles } from '../../db/schema';

type Row = typeof doublesTitles.$inferSelect;

/** Drizzle-backed DoublesTitleRepository (P7c). Append-only, `tournament_id`
 * as the primary key (one doubles champion per tournament, structurally).
 * `onConflictDoNothing` so a re-run of the final never double-writes. */
export class DrizzleDoublesTitleRepository implements DoublesTitleRepository {
  constructor(private readonly db: Db) {}

  async append(title: DoublesTitleRecord): Promise<void> {
    await this.db
      .insert(doublesTitles)
      .values({
        tournamentId: title.tournamentId,
        playerA: title.playerA,
        playerB: title.playerB,
        tier: title.tier,
        ageBand: title.ageBand,
        seasonEarned: title.weekEarned.season,
        weekEarned: title.weekEarned.week,
      })
      .onConflictDoNothing();
  }

  async findByPlayer(playerId: PlayerId): Promise<DoublesTitleRecord[]> {
    const rows = await this.db
      .select()
      .from(doublesTitles)
      .where(or(eq(doublesTitles.playerA, playerId), eq(doublesTitles.playerB, playerId)));
    return rows.map(toDomain);
  }
}

function toDomain(row: Row): DoublesTitleRecord {
  return {
    tournamentId: TournamentId(row.tournamentId),
    playerA: PlayerId(row.playerA),
    playerB: PlayerId(row.playerB),
    tier: row.tier as TournamentTier,
    ageBand: row.ageBand as AgeBand | null,
    weekEarned: { season: row.seasonEarned, week: row.weekEarned } as GameWeek,
  };
}
