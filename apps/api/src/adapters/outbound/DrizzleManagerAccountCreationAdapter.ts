import { eq } from 'drizzle-orm';
import { ManagerAccount, ManagerAccountCreationPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerProgression, managers } from '../../db/schema';
import { toAccount } from './DrizzleManagerAccountRepository';

/**
 * See ManagerAccountCreationPort's doc comment for why this needs to
 * exist at all: creating a manager account and granting its opening XP
 * balance must be one atomic, idempotent step, because a brand-new
 * manager's first page load fires several parallel manager-scoped
 * requests. Previously the use case did `findByAuthSubject` then `save`
 * then `credit` — a check-then-act race in which every concurrent request
 * missed the lookup and credited again (observed live: a single new
 * manager starting with several times the intended STARTER_XP_BALANCE),
 * and a concurrent read could even catch the account between the two
 * writes and report 0 XP.
 *
 * The gate is a single conditional insert of the managers row: the
 * `ON CONFLICT DO NOTHING` makes exactly one concurrent caller the
 * creator, and only that caller inserts the manager_progression row with
 * the starter balance. Both writes run in one db.transaction(), so the
 * account is never visible before its opening balance is — a losing
 * request's `ON CONFLICT` insert waits for the winner's commit and then
 * re-reads the committed row. The transaction is the same mechanism
 * DrizzleTalentClaimAdapter uses for its own cross-table guarantee.
 */
export class DrizzleManagerAccountCreationAdapter implements ManagerAccountCreationPort {
  constructor(private readonly db: Db) {}

  async createWithStarterXp(
    account: ManagerAccount,
    starterXp: number,
  ): Promise<{ account: ManagerAccount; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(managers)
        .values({
          id: account.id,
          authSubject: account.authSubject,
          displayName: account.displayName,
          publicHandle: account.publicHandle,
          status: account.status,
        })
        // No conflict target on purpose: a concurrent first-request can
        // collide on auth_subject (production mints a fresh random id per
        // request) or on id (the dev adapter pins the id from
        // x-dev-manager-id), and both simply mean "somebody else created
        // it" — never an error.
        .onConflictDoNothing()
        .returning();

      if (inserted.length > 0) {
        await tx
          .insert(managerProgression)
          .values({ managerId: account.id, xpBalance: starterXp })
          // Only the creator reaches this line, so this is the single
          // grant. Belt-and-braces onConflictDoNothing guards the one
          // outcome worth being paranoid about (a stale progression row
          // predating the account) against a double grant.
          .onConflictDoNothing();
        return { account: toAccount(inserted[0]), created: true };
      }

      const rows = await tx
        .select()
        .from(managers)
        .where(eq(managers.authSubject, account.authSubject))
        .limit(1);
      if (rows.length === 0) {
        // Conflicted on id but the auth_subject isn't present — only
        // reachable if a dev id was reused under a different subject.
        // Surface it rather than returning a wrong account.
        throw new Error(`Manager account ${account.id} already exists under a different auth subject`);
      }
      return { account: toAccount(rows[0]), created: false };
    });
  }
}
