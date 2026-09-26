import { eq, inArray, sql } from 'drizzle-orm';
import { AgeBand, PlayerId, TitleRecord, TitleTally, TournamentId, TournamentTier, titleWeightFor } from '@tennis-manager/domain';
import { TitleRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { titles } from '../../db/schema';

/**
 * Append-only, but "append" here really does mean insert-once: since
 * `tournament_id` is the table's primary key (see titles' own schema
 * doc comment), a second append for the same tournament is a real
 * constraint violation, not something this adapter silently
 * deduplicates — Tournament.recordMatchOutcome already refuses to
 * record a match's outcome twice, so SimulateMatchUseCase can never
 * legitimately reach this twice for the same final.
 */
export class DrizzleTitleRepository implements TitleRepository {
  constructor(private readonly db: Db) {}

  async append(title: TitleRecord): Promise<void> {
    await this.db.insert(titles).values({
      tournamentId: title.tournamentId,
      playerId: title.playerId,
      tier: title.tier,
      ageBand: title.ageBand,
      seasonEarned: title.weekEarned.season,
      weekEarned: title.weekEarned.week,
    });
  }

  async findByPlayer(playerId: PlayerId): Promise<TitleRecord[]> {
    const rows = await this.db.select().from(titles).where(eq(titles.playerId, playerId));
    return rows.map(toTitleRecord);
  }

  /**
   * Batch title tallies for the Scouting pool's career signal — a free
   * agent who has already won titles is visibly experienced rather than a
   * surprise after signing, AND the raw count never stands alone: it
   * carries the tier-weighted total and per-tier breakdown alongside it
   * (see TitleWeight.ts), so a pile of J30/J60 titles cannot read the same
   * as a major. One grouped query for the whole pool (grouped by player
   * AND tier), not one `findByPlayer` per free agent. Ids with no titles
   * are simply absent from the map (callers read a missing key as a zero
   * tally).
   */
  async countByPlayers(playerIds: PlayerId[]): Promise<Map<PlayerId, TitleTally>> {
    if (playerIds.length === 0) return new Map();
    const rows = await this.db
      .select({ playerId: titles.playerId, tier: titles.tier, count: sql<number>`count(*)::int` })
      .from(titles)
      .where(inArray(titles.playerId, playerIds))
      .groupBy(titles.playerId, titles.tier);
    const tallies = new Map<PlayerId, TitleTally>();
    for (const row of rows) {
      const playerId = PlayerId(row.playerId);
      const tier = row.tier as TournamentTier;
      const tally = tallies.get(playerId) ?? { count: 0, weight: 0, byTier: {} };
      tally.count += row.count;
      tally.weight += row.count * titleWeightFor(tier);
      tally.byTier[tier] = (tally.byTier[tier] ?? 0) + row.count;
      tallies.set(playerId, tally);
    }
    return tallies;
  }
}

function toTitleRecord(row: typeof titles.$inferSelect): TitleRecord {
  return {
    tournamentId: TournamentId(row.tournamentId),
    playerId: PlayerId(row.playerId),
    tier: row.tier as TournamentTier,
    ageBand: row.ageBand as AgeBand | null,
    weekEarned: { season: row.seasonEarned, week: row.weekEarned },
  };
}
