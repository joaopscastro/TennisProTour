import { ManagerId } from '@tennis-manager/domain';
import { ManagerAccountRepository, ManagerContactPort } from '@tennis-manager/application';

/**
 * The narrow slice of Clerk's client this adapter actually uses. Declared
 * structurally (rather than typed against `@clerk/backend`'s full
 * `ClerkClient`) so a test can pass a tiny fake — `createClerkClient({ secretKey })`
 * satisfies this shape. Only ever calls the read-only user lookup.
 */
export interface ClerkUserDirectory {
  users: {
    getUser(userId: string): Promise<{ primaryEmailAddress: { emailAddress: string } | null }>;
  };
}

/**
 * Notifications bounded context (STAGE 2) — resolves a manager's email
 * address on demand from Clerk, in `resend` mode only.
 *
 * The address is NEVER stored locally: the digest use case asks for it
 * at send time, so if a manager changes their email in Clerk the very
 * next digest uses the new one, with no sync job and no stale copy to
 * leak. The local `ManagerAccount` only contributes the `authSubject`
 * (the Clerk user id) — a dev subject (`dev:...`, see
 * DevelopmentAuthAdapter) has no Clerk user behind it at all, so it
 * resolves to null and the digest is skipped.
 *
 * Deliberately returns null on ANY Clerk failure (network, 404, bad
 * key) rather than throwing: "we couldn't resolve an address right now"
 * is an ordinary skip, exactly like "this manager has no address" — see
 * ManagerContactPort's doc comment. A thrown error here would be
 * classified as a failed send and would mark the delivery row failed,
 * wrongly consuming the manager's one window slot for a transient
 * lookup problem.
 */
export class ClerkManagerContactAdapter implements ManagerContactPort {
  constructor(
    private readonly managers: ManagerAccountRepository,
    private readonly clerk: ClerkUserDirectory,
  ) {}

  async emailFor(managerId: ManagerId): Promise<string | null> {
    try {
      const account = await this.managers.findById(managerId);
      if (!account) return null;
      if (account.authSubject.startsWith('dev:')) return null;
      const user = await this.clerk.users.getUser(account.authSubject);
      return user.primaryEmailAddress?.emailAddress ?? null;
    } catch {
      return null;
    }
  }
}
