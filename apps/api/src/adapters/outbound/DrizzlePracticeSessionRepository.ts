import { and, eq } from 'drizzle-orm';
import { GameDay, PlayerId } from '@tennis-manager/domain';
import { PracticeSessionRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { practiceSessions } from '../../db/schema';

/** Drizzle-backed PracticeSessionRepository (P8a). The composite
 * (player_id, season, week, day) primary key is the once-per-day guard:
 * `record` is an insert; a second same-day record is a PK conflict, so
 * `recordedOn` (a plain SELECT) is the honest check. */
export class DrizzlePracticeSessionRepository implements PracticeSessionRepository {
  constructor(private readonly db: Db) {}

  async recordedOn(playerId: PlayerId, day: GameDay): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(practiceSessions)
      .where(
        and(
          eq(practiceSessions.playerId, playerId),
          eq(practiceSessions.season, day.season),
          eq(practiceSessions.week, day.week),
          eq(practiceSessions.day, day.day),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async record(playerId: PlayerId, day: GameDay): Promise<void> {
    await this.db
      .insert(practiceSessions)
      .values({ playerId, season: day.season, week: day.week, day: day.day })
      .onConflictDoNothing();
  }
}
