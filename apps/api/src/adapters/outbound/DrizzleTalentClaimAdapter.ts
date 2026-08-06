import { and, eq, gte, sql } from 'drizzle-orm';
import { ManagerId, TalentPoolCandidateId } from '@tennis-manager/domain';
import { TalentClaimOutcome, TalentClaimPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerProgression, talentPoolCandidates } from '../../db/schema';
import { toDomain } from './DrizzleTalentPoolCandidateRepository';

/** Thrown only to trigger Postgres transaction rollback from inside the
 * db.transaction() callback below — never escapes claimAndCharge()
 * itself, which catches it and converts it back into a typed
 * TalentClaimOutcome. Not a real error condition from the caller's
 * perspective (a candidate being unavailable or a manager being short
 * on XP are both ordinary, expected outcomes, not exceptional ones). */
class ClaimRollback extends Error {
  constructor(readonly outcome: TalentClaimOutcome) {
    super('claim rollback');
  }
}

/**
 * See TalentClaimPort's doc comment for why this needs to exist at
 * all: claiming a candidate and debiting XP must succeed or fail
 * together. This is the one place in the codebase (besides
 * AdvanceWorldWeekUseCase's documented, accepted gap) that reaches for
 * a real db.transaction() rather than a single conditional UPDATE,
 * because the guarantee spans two separate tables that no single
 * UPDATE's WHERE clause can cover at once.
 *
 * Order of operations matters: XP is debited FIRST (cheapest failure
 * to detect, and avoids ever writing to talent_pool_candidates for a
 * manager who can't afford the claim at all), then the candidate claim
 * is attempted. If the candidate turns out to already be claimed, a
 * ClaimRollback is thrown to undo the XP debit that already
 * succeeded — Postgres's transaction rollback is what makes "undo an
 * already-applied UPDATE" trivial and correct here, instead of hand-
 * rolling a compensating write.
 */
export class DrizzleTalentClaimAdapter implements TalentClaimPort {
  constructor(private readonly db: Db) {}

  async claimAndCharge(candidateId: TalentPoolCandidateId, managerId: ManagerId, xpCost: number): Promise<TalentClaimOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const spendRows = await tx
          .update(managerProgression)
          .set({ xpBalance: sql`${managerProgression.xpBalance} - ${xpCost}`, updatedAt: new Date() })
          .where(and(eq(managerProgression.managerId, managerId), gte(managerProgression.xpBalance, xpCost)))
          .returning();

        if (spendRows.length === 0) {
          const balanceRows = await tx
            .select({ xpBalance: managerProgression.xpBalance })
            .from(managerProgression)
            .where(eq(managerProgression.managerId, managerId))
            .limit(1);
          const balance = balanceRows.length > 0 ? balanceRows[0].xpBalance : 0;
          throw new ClaimRollback({ kind: 'insufficient-xp', required: xpCost, balance });
        }

        const claimRows = await tx
          .update(talentPoolCandidates)
          .set({ status: 'claimed', claimedByManagerId: managerId, updatedAt: new Date() })
          .where(and(eq(talentPoolCandidates.id, candidateId), eq(talentPoolCandidates.status, 'available')))
          .returning();

        if (claimRows.length === 0) {
          throw new ClaimRollback({ kind: 'candidate-unavailable' });
        }

        return { kind: 'claimed', candidate: toDomain(claimRows[0]), xpSpent: xpCost };
      });
    } catch (error) {
      if (error instanceof ClaimRollback) return error.outcome;
      throw error;
    }
  }
}
