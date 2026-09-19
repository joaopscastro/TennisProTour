import { describe, expect, it, vi } from 'vitest';
import { ManagerId } from '@tennis-manager/domain';
import { ManagerAccount, ManagerAccountRepository } from '@tennis-manager/application';
import { ClerkManagerContactAdapter, ClerkUserDirectory } from './ClerkManagerContactAdapter';

class FakeManagerAccountRepository implements ManagerAccountRepository {
  constructor(private readonly accounts: Record<string, ManagerAccount>) {}
  async findByAuthSubject(authSubject: string): Promise<ManagerAccount | null> {
    return Object.values(this.accounts).find((a) => a.authSubject === authSubject) ?? null;
  }
  async findById(id: ManagerId): Promise<ManagerAccount | null> {
    return this.accounts[id] ?? null;
  }
  async save(): Promise<void> {}
}

function account(id: string, authSubject: string): ManagerAccount {
  return { id: ManagerId(id), authSubject, displayName: id, publicHandle: id, status: 'active' };
}

function clerkReturning(email: string | null): ClerkUserDirectory {
  return { users: { getUser: vi.fn(async () => ({ primaryEmailAddress: email === null ? null : { emailAddress: email } })) } };
}

describe('ClerkManagerContactAdapter', () => {
  const managerId = ManagerId('m1');

  it('resolves the Clerk primary email for a real account', async () => {
    const managers = new FakeManagerAccountRepository({ m1: account('m1', 'user_abc') });
    const clerk = clerkReturning('alice@example.com');
    const adapter = new ClerkManagerContactAdapter(managers, clerk);

    expect(await adapter.emailFor(managerId)).toBe('alice@example.com');
    expect(clerk.users.getUser).toHaveBeenCalledWith('user_abc');
  });

  it('returns null for a dev: subject without calling Clerk', async () => {
    const managers = new FakeManagerAccountRepository({ m1: account('m1', 'dev:m1') });
    const clerk = clerkReturning('alice@example.com');
    const adapter = new ClerkManagerContactAdapter(managers, clerk);

    expect(await adapter.emailFor(managerId)).toBeNull();
    expect(clerk.users.getUser).not.toHaveBeenCalled();
  });

  it('returns null when Clerk throws (never propagates)', async () => {
    const managers = new FakeManagerAccountRepository({ m1: account('m1', 'user_abc') });
    const clerk: ClerkUserDirectory = {
      users: {
        getUser: vi.fn(async () => {
          throw new Error('clerk is down');
        }),
      },
    };
    const adapter = new ClerkManagerContactAdapter(managers, clerk);

    await expect(adapter.emailFor(managerId)).resolves.toBeNull();
  });

  it('returns null for an unknown account or a user with no primary email', async () => {
    const unknown = new ClerkManagerContactAdapter(new FakeManagerAccountRepository({}), clerkReturning('x@y.com'));
    expect(await unknown.emailFor(managerId)).toBeNull();

    const noEmail = new ClerkManagerContactAdapter(
      new FakeManagerAccountRepository({ m1: account('m1', 'user_abc') }),
      clerkReturning(null),
    );
    expect(await noEmail.emailFor(managerId)).toBeNull();
  });
});
