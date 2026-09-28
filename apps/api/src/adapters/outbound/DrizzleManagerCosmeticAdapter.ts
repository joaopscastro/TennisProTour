import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { ManagerId } from '@tennis-manager/domain';
import { CosmeticPurchaseOutcome, ManagerCosmeticPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerCosmetics, managerProgression } from '../../db/schema';

/** Thrown only to trigger Postgres transaction rollback from inside the
 * db.transaction() callback below — never escapes purchaseAndCharge()
 * itself, which catches it and converts it back into a typed
 * CosmeticPurchaseOutcome. An already-owned item or a short balance are
 * ordinary, expected outcomes, not exceptional ones. */
class CosmeticPurchaseRollback extends Error {
  constructor(readonly outcome: CosmeticPurchaseOutcome) {
    super('cosmetic purchase rollback');
  }
}

/**
 * Drizzle-backed ManagerCosmeticPort (Batch 4B, F2). See the port's doc
 * comment for why purchaseAndCharge spans two tables and therefore needs
 * a real db.transaction() — the same shape as DrizzleTalentClaimAdapter
 * and DrizzleCoachConversionAdapter.
 *
 * Order mirrors those adapters: debit XP FIRST (the cheapest failure to
 * detect, and it never touches the unlock table for a manager who can't
 * afford the item), then claim the unlock with
 * `.onConflictDoNothing().returning()` — a row comes back only if THIS
 * statement actually inserted it, so the composite (manager, item)
 * primary key makes "already owned" a same-statement answer rather than
 * a read-then-write check, and two racing double-submits can never both
 * charge. If the claim is refused, the rollback undoes the already-
 * applied XP debit via Postgres's own transaction rollback — no
 * hand-rolled compensating write.
 */
export class DrizzleManagerCosmeticAdapter implements ManagerCosmeticPort {
  constructor(private readonly db: Db) {}

  async ownedFor(managerId: ManagerId): Promise<string[]> {
    const rows = await this.db
      .select({ itemId: managerCosmetics.itemId })
      .from(managerCosmetics)
      .where(eq(managerCosmetics.managerId, managerId));
    return rows.map((row) => row.itemId);
  }

  async ownedByManagers(managerIds: ManagerId[]): Promise<Map<string, string[]>> {
    if (managerIds.length === 0) return new Map();
    const rows = await this.db
      .select({ managerId: managerCosmetics.managerId, itemId: managerCosmetics.itemId })
      .from(managerCosmetics)
      .where(inArray(managerCosmetics.managerId, managerIds));
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const list = result.get(row.managerId);
      if (list) list.push(row.itemId);
      else result.set(row.managerId, [row.itemId]);
    }
    return result;
  }

  async purchaseAndCharge(input: {
    managerId: ManagerId;
    itemId: string;
    xpCost: number;
  }): Promise<CosmeticPurchaseOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const spendRows = await tx
          .update(managerProgression)
          .set({ xpBalance: sql`${managerProgression.xpBalance} - ${input.xpCost}`, updatedAt: new Date() })
          .where(and(eq(managerProgression.managerId, input.managerId), gte(managerProgression.xpBalance, input.xpCost)))
          .returning();

        if (spendRows.length === 0) {
          const balanceRows = await tx
            .select({ xpBalance: managerProgression.xpBalance })
            .from(managerProgression)
            .where(eq(managerProgression.managerId, input.managerId))
            .limit(1);
          const balance = balanceRows.length > 0 ? balanceRows[0].xpBalance : 0;
          throw new CosmeticPurchaseRollback({ kind: 'insufficient-xp', required: input.xpCost, balance });
        }

        const claimRows = await tx
          .insert(managerCosmetics)
          .values({ managerId: input.managerId, itemId: input.itemId })
          .onConflictDoNothing()
          .returning({ itemId: managerCosmetics.itemId });

        if (claimRows.length === 0) {
          throw new CosmeticPurchaseRollback({ kind: 'already-owned' });
        }

        return { kind: 'purchased', itemId: input.itemId, xpSpent: input.xpCost };
      });
    } catch (error) {
      if (error instanceof CosmeticPurchaseRollback) return error.outcome;
      throw error;
    }
  }
}
