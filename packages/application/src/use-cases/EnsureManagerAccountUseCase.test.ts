import { describe, expect, it } from 'vitest';
import { ManagerId } from '@tennis-manager/domain';
import {
  IdGeneratorPort,
  ManagerAccount,
  ManagerAccountCreationPort,
  ManagerAccountRepository,
  ManagerXpRepository,
} from '../ports/ports';
import { EnsureManagerAccountUseCase, STARTER_XP_BALANCE } from './EnsureManagerAccountUseCase';

class InMemoryManagerAccountRepository implements ManagerAccountRepository {
  private readonly store = new Map<string, ManagerAccount>();

  async findByAuthSubject(authSubject: string): Promise<ManagerAccount | null> {
    return [...this.store.values()].find((a) => a.authSubject === authSubject) ?? null;
  }

  async findById(id: ManagerId): Promise<ManagerAccount | null> {
    return this.store.get(id) ?? null;
  }

  async save(account: ManagerAccount): Promise<void> {
    this.store.set(account.id, account);
  }

  all(): ManagerAccount[] {
    return [...this.store.values()];
  }
}

class InMemoryManagerXpRepository implements ManagerXpRepository {
  private readonly balances = new Map<ManagerId, number>();
  creditCalls = 0;

  async balanceFor(managerId: ManagerId): Promise<number> {
    return this.balances.get(managerId) ?? 0;
  }

  async credit(managerId: ManagerId, amount: number): Promise<void> {
    this.creditCalls += 1;
    this.balances.set(managerId, (this.balances.get(managerId) ?? 0) + amount);
  }

  async spendXpIfSufficient(managerId: ManagerId, amount: number): Promise<boolean> {
    const balance = this.balances.get(managerId) ?? 0;
    if (balance < amount) return false;
    this.balances.set(managerId, balance - amount);
    return true;
  }
}

/** In-memory stand-in for the atomic create-and-grant adapter: the check
 * and both writes run with NO await between them, so — like a real DB
 * transaction — it can never interleave. The genuine concurrent guarantee
 * lives in DrizzleManagerAccountCreationAdapter's single transaction and
 * is covered against real Postgres in the api integration suite. */
class InMemoryManagerAccountCreationPort implements ManagerAccountCreationPort {
  constructor(
    private readonly managers: InMemoryManagerAccountRepository,
    private readonly managerXp: InMemoryManagerXpRepository,
  ) {}

  async createWithStarterXp(
    account: ManagerAccount,
    starterXp: number,
  ): Promise<{ account: ManagerAccount; created: boolean }> {
    const existing = await this.managers.findByAuthSubject(account.authSubject);
    if (existing) return { account: existing, created: false };
    await this.managers.save(account);
    await this.managerXp.credit(account.id, starterXp);
    return { account, created: true };
  }
}

class SequentialIdGenerator implements IdGeneratorPort {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    return `m-${this.counter}`;
  }
}

function setup() {
  const managers = new InMemoryManagerAccountRepository();
  const managerXp = new InMemoryManagerXpRepository();
  const accountCreation = new InMemoryManagerAccountCreationPort(managers, managerXp);
  const useCase = new EnsureManagerAccountUseCase(managers, new SequentialIdGenerator(), accountCreation);
  return { managers, managerXp, useCase };
}

describe('EnsureManagerAccountUseCase onboarding', () => {
  it('grants STARTER_XP_BALANCE to a brand-new manager so they can sign a first player', async () => {
    const { managerXp, useCase } = setup();

    const account = await useCase.execute({ authSubject: 'new-subject' });

    expect(await managerXp.balanceFor(account.id)).toBe(STARTER_XP_BALANCE);
    expect(managerXp.creditCalls).toBe(1);
    expect(STARTER_XP_BALANCE).toBeGreaterThanOrEqual(50); // at least one claim's worth
  });

  it('does NOT re-grant starter XP to a returning manager', async () => {
    const { managerXp, useCase } = setup();

    const first = await useCase.execute({ authSubject: 'returning' });
    // Simulate the manager spending some of it.
    await managerXp.spendXpIfSufficient(first.id, 300);
    const afterSpend = await managerXp.balanceFor(first.id);

    await useCase.execute({ authSubject: 'returning' });

    expect(await managerXp.balanceFor(first.id)).toBe(afterSpend);
    expect(managerXp.creditCalls).toBe(1); // exactly one grant, ever
  });

  it('does not credit a suspended account (and still throws)', async () => {
    const { managers, managerXp, useCase } = setup();
    await managers.save({
      id: ManagerId('m-suspended'),
      authSubject: 'suspended-subject',
      displayName: 'Suspended',
      publicHandle: 'manager-m-suspended',
      status: 'suspended',
    });

    await expect(useCase.execute({ authSubject: 'suspended-subject' })).rejects.toThrow(/suspended/);
    expect(await managerXp.balanceFor(ManagerId('m-suspended'))).toBe(0);
    expect(managerXp.creditCalls).toBe(0);
  });

  it('does not credit a deleted account, and the dev-id guard still throws before any grant', async () => {
    const { managers, managerXp, useCase } = setup();
    await managers.save({
      id: ManagerId('gone'),
      authSubject: 'deleted:gone', // anonymized subject, so findByAuthSubject misses it
      displayName: 'Deleted manager',
      publicHandle: 'deleted-gone',
      status: 'deleted',
    });

    await expect(
      useCase.execute({ authSubject: 'dev:gone', developmentManagerId: ManagerId('gone') }),
    ).rejects.toThrow(/deleted/);
    expect(await managerXp.balanceFor(ManagerId('gone'))).toBe(0);
    expect(managerXp.creditCalls).toBe(0);
  });

  it('grants starter XP to a dev-mode manager identified by x-dev-manager-id', async () => {
    const { managerXp, useCase } = setup();

    const account = await useCase.execute({ authSubject: 'dev:bot-1', developmentManagerId: ManagerId('bot-1') });

    expect(account.id).toBe('bot-1');
    expect(await managerXp.balanceFor(account.id)).toBe(STARTER_XP_BALANCE);
  });
});
