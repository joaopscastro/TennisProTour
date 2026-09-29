import { and, eq } from 'drizzle-orm';
import { GameWeek, ManagerId, PlayerId, TournamentId } from '@tennis-manager/domain';
import { ManagerEntryActivityRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerEntryActivity } from '../../db/schema';

/**
 * Drizzle adapter for the manager entry-activity ledger (see
 * ManagerEntryActivityRepository's doc comment for why the weekly
 * inactivity deduction needs its own record instead of a read of
 * tournament rows).
 *
 * `record` is an `ON CONFLICT DO NOTHING` insert against the
 * (manager, season, week) primary key: the FIRST entry of a week writes
 * the row, every later entry that same week is a no-op, and nothing is
 * ever overwritten. `findManagerIdsWithActivityInWeek` is one DISTINCT
 * SELECT — called once per weekly rollover, not per manager.
 */
export class DrizzleManagerEntryActivityRepository implements ManagerEntryActivityRepository {
  constructor(private readonly db: Db) {}

  async record(
    managerId: ManagerId,
    week: GameWeek,
    playerId: PlayerId,
    tournamentId: TournamentId,
  ): Promise<void> {
    await this.db
      .insert(managerEntryActivity)
      .values({
        managerId,
        season: week.season,
        week: week.week,
        playerId,
        tournamentId,
      })
      .onConflictDoNothing();
  }

  async findManagerIdsWithActivityInWeek(week: GameWeek): Promise<ManagerId[]> {
    const rows = await this.db
      .selectDistinct({ managerId: managerEntryActivity.managerId })
      .from(managerEntryActivity)
      .where(and(eq(managerEntryActivity.season, week.season), eq(managerEntryActivity.week, week.week)));
    return rows.map((row) => ManagerId(row.managerId));
  }
}
