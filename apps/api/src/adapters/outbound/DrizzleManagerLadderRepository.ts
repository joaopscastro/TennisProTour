import { desc, eq, gt, sql } from 'drizzle-orm';
import { ManagerId } from '@tennis-manager/domain';
import { ManagerLadderRepository, ManagerLadderStanding } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerLadder } from '../../db/schema';

/**
 * Drizzle adapter for the decaying manager ladder (see
 * ManagerLadderRepository). credit() is a commutative upsert (score =
 * score + amount) exactly like DrizzleManagerXpRepository.credit;
 * decayAll() is a single whole-table UPDATE so its cost is independent
 * of the number of managers who played that week; topStandings() is the
 * public leaderboard read, ordered by the indexed score column and
 * excluding never-scored (0) managers.
 */
export class DrizzleManagerLadderRepository implements ManagerLadderRepository {
  constructor(private readonly db: Db) {}

  async scoreFor(managerId: ManagerId): Promise<number> {
    const rows = await this.db
      .select()
      .from(managerLadder)
      .where(eq(managerLadder.managerId, managerId))
      .limit(1);
    return rows.length > 0 ? rows[0].score : 0;
  }

  async credit(managerId: ManagerId, amount: number): Promise<void> {
    if (amount <= 0) return;
    await this.db
      .insert(managerLadder)
      .values({ managerId, score: amount })
      .onConflictDoUpdate({
        target: managerLadder.managerId,
        set: { score: sql`${managerLadder.score} + ${amount}`, updatedAt: new Date() },
      });
  }

  async decayAll(factor: number): Promise<void> {
    await this.db.update(managerLadder).set({ score: sql`${managerLadder.score} * ${factor}` });
  }

  async topStandings(limit: number): Promise<ManagerLadderStanding[]> {
    const rows = await this.db
      .select()
      .from(managerLadder)
      .where(gt(managerLadder.score, 0))
      .orderBy(desc(managerLadder.score))
      .limit(limit);
    return rows.map((row) => ({ managerId: ManagerId(row.managerId), score: row.score }));
  }

  async rankFor(managerId: ManagerId): Promise<number | null> {
    const rows = await this.db
      .select()
      .from(managerLadder)
      .where(eq(managerLadder.managerId, managerId))
      .limit(1);
    if (rows.length === 0 || rows[0].score <= 0) return null;
    const score = rows[0].score;
    const higher = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(managerLadder)
      .where(gt(managerLadder.score, score));
    return (higher[0]?.count ?? 0) + 1;
  }
}
