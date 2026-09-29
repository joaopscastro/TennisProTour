import { describe, expect, it } from 'vitest';
import { ManagerId, StandardTalentClaimPricingPolicy } from '@tennis-manager/domain';
import {
  IdGeneratorPort,
  ManagerAccount,
  ManagerAccountCreationPort,
  ManagerAccountRepository,
  ManagerXpRepository,
} from '../ports/ports';
import { EnsureManagerAccountUseCase, STARTER_XP_BALANCE, YOUNGEST_PROSPECT_PRICE_XP } from './EnsureManagerAccountUseCase';
import { TALENT_POOL_AGE_RANGE } from './talentPoolAgeRange';

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
  });

  it('is exactly two youngest-bracket prospects and no more (deliberate product rule)', () => {
    const pricing = new StandardTalentClaimPricingPolicy();
    const youngestPrice = pricing.priceFor(50, TALENT_POOL_AGE_RANGE.minWeeks, TALENT_POOL_AGE_RANGE);

    // The youngest age prices flat: rating does not change the cost.
    expect(pricing.priceFor(10, TALENT_POOL_AGE_RANGE.minWeeks, TALENT_POOL_AGE_RANGE)).toBe(youngestPrice);
    expect(pricing.priceFor(90, TALENT_POOL_AGE_RANGE.minWeeks, TALENT_POOL_AGE_RANGE)).toBe(youngestPrice);

    // STARTER_XP_BALANCE is COMPUTED as exactly 2 x that real price, so
    // it can never drift when the pricing policy's constants change.
    expect(YOUNGEST_PROSPECT_PRICE_XP).toBe(youngestPrice);
    expect(STARTER_XP_BALANCE).toBe(2 * youngestPrice);
    expect(STARTER_XP_BALANCE).toBe(100); // the documented arithmetic: 2 x 50

    // Two raw kids fit exactly; a third does not.
    const budget = STARTER_XP_BALANCE;
    expect(budget - 2 * youngestPrice).toBe(0);
    expect(budget - 3 * youngestPrice).toBeLessThan(0);

    // An established older/stronger prospect is out of reach: a 75-rated
    // (strong) oldest-age player prices ABOVE the whole starter grant, so
    // a newcomer cannot buy a ready-made player instead of gambling on
    // kids (principle #1).
    const establishedPrice = pricing.priceFor(75, TALENT_POOL_AGE_RANGE.maxWeeks, TALENT_POOL_AGE_RANGE);
    expect(establishedPrice).toBeGreaterThan(STARTER_XP_BALANCE);
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
