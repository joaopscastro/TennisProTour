import { and, eq, inArray, or } from 'drizzle-orm';
import { DoublesPair, DoublesPairStatus, PairId, PlayerId } from '@tennis-manager/domain';
import { DoublesPairRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { doublesPairs } from '../../db/schema';

type PairRow = typeof doublesPairs.$inferSelect;

/** Drizzle-backed DoublesPairRepository. `save` is an upsert (a pair's
 * status mutates in place: pending → active → dissolved), matching the
 * aggregate's own mutable-status design — there is deliberately no
 * delete, a dissolved pair stays as a row (same "keep history" shape as
 * Coach). findByPlayer/findByPlayers read the two indexed player columns
 * (idx_doubles_pairs_player_a/_b). */
export class DrizzleDoublesPairRepository implements DoublesPairRepository {
  constructor(private readonly db: Db) {}

  async findById(id: PairId): Promise<DoublesPair | null> {
    const rows = await this.db.select().from(doublesPairs).where(eq(doublesPairs.id, id)).limit(1);
    if (rows.length === 0) return null;
    return toDomain(rows[0]);
  }

  async findByPlayer(playerId: PlayerId): Promise<DoublesPair[]> {
    const rows = await this.db
      .select()
      .from(doublesPairs)
      .where(or(eq(doublesPairs.playerA, playerId), eq(doublesPairs.playerB, playerId)));
    return rows.map(toDomain);
  }

  async findByPlayers(playerIds: PlayerId[]): Promise<DoublesPair[]> {
    if (playerIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(doublesPairs)
      .where(or(inArray(doublesPairs.playerA, playerIds), inArray(doublesPairs.playerB, playerIds)));
    return rows.map(toDomain);
  }

  async findActive(): Promise<DoublesPair[]> {
    const rows = await this.db.select().from(doublesPairs).where(eq(doublesPairs.status, 'active'));
    return rows.map(toDomain);
  }

  async save(pair: DoublesPair): Promise<void> {
    await this.db
      .insert(doublesPairs)
      .values({
        id: pair.id,
        playerA: pair.playerA,
        playerB: pair.playerB,
        status: pair.status,
        chemistry: pair.chemistry,
      })
      .onConflictDoUpdate({
        target: doublesPairs.id,
        set: { status: pair.status, chemistry: pair.chemistry, updatedAt: new Date() },
      });
  }
}

function toDomain(row: PairRow): DoublesPair {
  return DoublesPair.reconstitute({
    id: PairId(row.id),
    playerA: PlayerId(row.playerA),
    playerB: PlayerId(row.playerB),
    status: row.status as DoublesPairStatus,
    chemistry: row.chemistry,
  });
}
