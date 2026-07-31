import { eq } from 'drizzle-orm';
import { GameWorld, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { gameWorlds } from '../../db/schema';

export class DrizzleGameWorldRepository implements GameWorldRepository {
  constructor(private readonly db: Db) {}

  async findById(id: WorldId): Promise<GameWorld | null> {
    const rows = await this.db.select().from(gameWorlds).where(eq(gameWorlds.id, id)).limit(1);
    if (rows.length === 0) return null;
    return GameWorld.reconstitute({
      id: WorldId(rows[0].id),
      currentWeek: { season: rows[0].season, week: rows[0].week },
      lastAppliedTick: rows[0].lastAppliedTick,
    });
  }

  async save(world: GameWorld): Promise<void> {
    const row = {
      id: world.id,
      season: world.currentWeek.season,
      week: world.currentWeek.week,
      lastAppliedTick: world.lastAppliedTick,
    };
    await this.db
      .insert(gameWorlds)
      .values(row)
      .onConflictDoUpdate({ target: gameWorlds.id, set: { ...row, updatedAt: new Date() } });
  }
}
