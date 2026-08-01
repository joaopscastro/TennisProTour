import { eq } from 'drizzle-orm';
import { ManagerId, ManagerRanking } from '@tennis-manager/domain';
import { ManagerRankingRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerRankings } from '../../db/schema';

export class DrizzleManagerRankingRepository implements ManagerRankingRepository {
  constructor(private readonly db: Db) {}

  async findById(managerId: ManagerId): Promise<ManagerRanking | null> {
    const rows = await this.db.select().from(managerRankings).where(eq(managerRankings.managerId, managerId)).limit(1);
    if (rows.length === 0) return null;
    return ManagerRanking.reconstitute({
      managerId: ManagerId(rows[0].managerId),
      totalPoints: rows[0].totalPoints,
    });
  }

  async save(ranking: ManagerRanking): Promise<void> {
    const row = {
      managerId: ranking.managerId,
      totalPoints: ranking.totalPoints,
    };
    await this.db
      .insert(managerRankings)
      .values(row)
      .onConflictDoUpdate({ target: managerRankings.managerId, set: { ...row, updatedAt: new Date() } });
  }
}
