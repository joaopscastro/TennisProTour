import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { TalentClaimOutcome, TalentClaimPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerProgression, players } from '../../db/schema';
import { toDomain } from './DrizzlePlayerRepository';

/** Thrown only to trigger Postgres transaction rollback from inside the
 * db.transaction() callback below — never escapes claimAndCharge()
 * itself, which catches it and converts it back into a typed
 * TalentClaimOutcome. Not a real error condition from the caller's
 * perspective (a free agent already being signed or a manager being
 * short on XP are both ordinary, expected outcomes, not exceptional
 * ones). */
class ClaimRollback extends Error {
  constructor(readonly outcome: TalentClaimOutcome) {
    super('claim rollback');
  }
}

/**
 * See TalentClaimPort's doc comment for why this needs to exist at all:
 * signing a free agent (transferring ownership on the players row) and
 * debiting XP must succeed or fail together. This is the one place in
 * the codebase (besides AdvanceWorldWeekUseCase's documented, accepted
 * gap) that reaches for a real db.transaction() rather than a single
 * conditional UPDATE, because the guarantee spans two separate tables
 * that no single UPDATE's WHERE clause can cover at once.
 *
 * As of the candidate/player unification (see docs/CLAUDE.md) there is
 * no talent_pool_candidates table involved anymore: the free agent is
 * already a real Player row, and signing it is a conditional
 * `UPDATE players SET manager_id = :mid, fill_only = false
 * WHERE id = :id AND manager_id IS NULL` — the `manager_id IS NULL`
 * predicate is what makes two managers racing for the same free agent
 * safe (exactly one UPDATE affects a row). fill_only is flipped off so
 * a signed player trains from its manager's schedule rather than the
 * auto weakest-attribute path.
 *
 * Order of operations matters: XP is debited FIRST (cheapest failure to
 * detect, and avoids ever touching the players row for a manager who
 * can't afford the signing at all), then the signing is attempted. If
 * the player turns out to already be owned, a ClaimRollback is thrown to
 * undo the XP debit that already succeeded — Postgres's transaction
 * rollback is what makes "undo an already-applied UPDATE" trivial and
 * correct here, instead of hand-rolling a compensating write.
 */
export class DrizzleTalentClaimAdapter implements TalentClaimPort {
  constructor(private readonly db: Db) {}

  async claimAndCharge(playerId: PlayerId, managerId: ManagerId, xpCost: number): Promise<TalentClaimOutcome> {
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

        const signRows = await tx
          .update(players)
          .set({ managerId, fillOnly: false, updatedAt: new Date() })
          .where(and(eq(players.id, playerId), isNull(players.managerId)))
          .returning();

        if (signRows.length === 0) {
          throw new ClaimRollback({ kind: 'player-unavailable' });
        }

        return { kind: 'claimed', player: toDomain(signRows[0]), xpSpent: xpCost };
      });
    } catch (error) {
      if (error instanceof ClaimRollback) return error.outcome;
      throw error;
    }
  }
}
