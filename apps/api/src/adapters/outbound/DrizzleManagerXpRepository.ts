import { and, eq, gte, sql } from 'drizzle-orm';
import { ManagerId } from '@tennis-manager/domain';
import { ManagerXpRepository } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerProgression } from '../../db/schema';

/**
 * See ManagerXpRepository's doc comment for why credit() is a plain
 * upsert (concurrent credits are commutative) while
 * spendXpIfSufficient() is a single conditional UPDATE ... WHERE
 * xp_balance >= amount RETURNING * — the same "WHERE re-checks the
 * guard as part of the same atomic statement" mechanism as
 * DrizzleTalentPoolCandidateRepository.claimIfAvailable() and
 * StripeBillingAdapter.consumeCustomPlayerCredit().
 */
export class DrizzleManagerXpRepository implements ManagerXpRepository {
  constructor(private readonly db: Db) {}

  async balanceFor(managerId: ManagerId): Promise<number> {
    const rows = await this.db
      .select()
      .from(managerProgression)
      .where(eq(managerProgression.managerId, managerId))
      .limit(1);
    return rows.length > 0 ? rows[0].xpBalance : 0;
  }

  async credit(managerId: ManagerId, amount: number): Promise<void> {
    await this.db
      .insert(managerProgression)
      .values({ managerId, xpBalance: amount })
      .onConflictDoUpdate({
        target: managerProgression.managerId,
        set: { xpBalance: sql`${managerProgression.xpBalance} + ${amount}`, updatedAt: new Date() },
      });
  }

  async spendXpIfSufficient(managerId: ManagerId, amount: number): Promise<boolean> {
    const rows = await this.db
      .update(managerProgression)
      .set({ xpBalance: sql`${managerProgression.xpBalance} - ${amount}`, updatedAt: new Date() })
      .where(and(eq(managerProgression.managerId, managerId), gte(managerProgression.xpBalance, amount)))
      .returning();
    return rows.length > 0;
  }
}
