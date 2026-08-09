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

  /**
   * Real wall-clock time of the last actually-applied tick
   * (`game_worlds.updated_at`) — bumped only inside `save()`, which
   * `AdvanceWorldWeekUseCase` only calls when a tick genuinely
   * advances the week (see that use case), never on a no-op re-fire.
   * Deliberately NOT part of the `GameWorldRepository` port / the
   * `GameWorld` aggregate itself: the domain never touches wall-clock
   * time (see `GameWorld`'s own doc comment) — this is purely an
   * operational read for `GET /world/clock`'s interval-mode countdown
   * (`worldRoutes.ts`), same "concrete Drizzle class exposed directly
   * on Dependencies for a read-side concern" pattern already used by
   * `DrizzleRosterDashboardQuery`/`DrizzlePlayerProfileQuery`.
   */
  async findLastTickAt(id: WorldId): Promise<Date | null> {
    const rows = await this.db.select({ updatedAt: gameWorlds.updatedAt }).from(gameWorlds).where(eq(gameWorlds.id, id)).limit(1);
    return rows[0]?.updatedAt ?? null;
  }
}
