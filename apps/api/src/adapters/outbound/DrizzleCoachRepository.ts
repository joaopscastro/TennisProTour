import { eq } from 'drizzle-orm';
import { Coach, CoachId, ManagerId, PlayerId } from '@tennis-manager/domain';
import { CoachRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { coaches } from '../../db/schema';

export class DrizzleCoachRepository implements CoachRepository {
  constructor(private readonly db: Db) {}

  async findByManager(managerId: ManagerId): Promise<Coach[]> {
    const rows = await this.db.select().from(coaches).where(eq(coaches.managerId, managerId));
    return rows.map(toDomain);
  }

  async save(coach: Coach): Promise<void> {
    await this.db
      .insert(coaches)
      .values({
        id: coach.id,
        managerId: coach.managerId,
        coachRating: coach.coachRating,
        sourcePlayerId: coach.sourcePlayerId,
        sourcePlayerName: coach.sourcePlayerName,
      })
      .onConflictDoNothing(); // conversion is permanent — a saved Coach never changes (see Coach's doc comment)
  }
}

function toDomain(row: typeof coaches.$inferSelect): Coach {
  return Coach.reconstitute({
    id: CoachId(row.id),
    managerId: ManagerId(row.managerId),
    coachRating: row.coachRating,
    sourcePlayerId: PlayerId(row.sourcePlayerId),
    sourcePlayerName: row.sourcePlayerName,
  });
}
