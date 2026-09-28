import { describe, expect, it } from 'vitest';
import { ManagerId } from '@tennis-manager/domain';
import { CosmeticPurchaseOutcome, ManagerCosmeticPort } from '../ports/ports';
import { PurchaseManagerCosmeticUseCase } from './PurchaseManagerCosmeticUseCase';

/** In-memory fake of the cross-table purchase port: a wallet map plus an
 * owned-set map, applying the exact same debit-then-record semantics the
 * Drizzle adapter gets from its transaction. */
class InMemoryManagerCosmeticPort implements ManagerCosmeticPort {
  readonly balances = new Map<string, number>();
  readonly owned = new Map<string, Set<string>>();
  /** Every purchase call actually attempted, for the unknown-item check. */
  purchaseCalls = 0;

  async ownedFor(managerId: ManagerId): Promise<string[]> {
    return [...(this.owned.get(managerId) ?? [])];
  }

  async ownedByManagers(managerIds: ManagerId[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const id of managerIds) {
      const set = this.owned.get(id);
      if (set && set.size > 0) result.set(id, [...set]);
    }
    return result;
  }

  async purchaseAndCharge(input: { managerId: ManagerId; itemId: string; xpCost: number }): Promise<CosmeticPurchaseOutcome> {
    this.purchaseCalls += 1;
    const balance = this.balances.get(input.managerId) ?? 0;
    const ownedSet = this.owned.get(input.managerId) ?? new Set<string>();
    if (ownedSet.has(input.itemId)) return { kind: 'already-owned' };
    if (balance < input.xpCost) {
      return { kind: 'insufficient-xp', required: input.xpCost, balance };
    }
    this.balances.set(input.managerId, balance - input.xpCost);
    ownedSet.add(input.itemId);
    this.owned.set(input.managerId, ownedSet);
    return { kind: 'purchased', itemId: input.itemId, xpSpent: input.xpCost };
  }
}

function setup() {
  const port = new InMemoryManagerCosmeticPort();
  port.balances.set('m1', 1000);
  const useCase = new PurchaseManagerCosmeticUseCase(port);
  return { port, useCase };
}

describe('PurchaseManagerCosmeticUseCase', () => {
  it('buys a catalog item at the CATALOG price, deducting the balance and recording the unlock', async () => {
    const { port, useCase } = setup();

    const result = await useCase.execute({ managerId: ManagerId('m1'), itemId: 'badge-star' });

    expect(result).toEqual({ itemId: 'badge-star', xpSpent: 200 });
    expect(port.balances.get('m1')).toBe(800);
    expect(await port.ownedFor(ManagerId('m1'))).toEqual(['badge-star']);
  });

  it('refuses an unknown item without touching the port or the balance', async () => {
    const { port, useCase } = setup();

    await expect(useCase.execute({ managerId: ManagerId('m1'), itemId: 'not-real' })).rejects.toThrow(
      /Unknown cosmetic item/,
    );
    expect(port.purchaseCalls).toBe(0);
    expect(port.balances.get('m1')).toBe(1000);
  });

  it('refuses a re-buy of an already-owned item without charging again', async () => {
    const { port, useCase } = setup();
    await useCase.execute({ managerId: ManagerId('m1'), itemId: 'badge-star' });

    await expect(useCase.execute({ managerId: ManagerId('m1'), itemId: 'badge-star' })).rejects.toThrow(
      /already owned/,
    );
    expect(port.balances.get('m1')).toBe(800); // charged exactly once
  });

  it('refuses a purchase the balance cannot cover, with the real numbers', async () => {
    const { port, useCase } = setup();
    port.balances.set('m1', 100);

    await expect(useCase.execute({ managerId: ManagerId('m1'), itemId: 'banner-obsidian' })).rejects.toThrow(
      /Insufficient XP to buy "Obsidian Banner": needs 1100, balance 100/,
    );
    expect(port.balances.get('m1')).toBe(100);
    expect(await port.ownedFor(ManagerId('m1'))).toEqual([]);
  });

  it('exposes the owned set through the port for the entitlement/leaderboard reads', async () => {
    const { port, useCase } = setup();
    await useCase.execute({ managerId: ManagerId('m1'), itemId: 'banner-classic' });
    await useCase.execute({ managerId: ManagerId('m1'), itemId: 'celebration-confetti' });

    expect((await port.ownedFor(ManagerId('m1'))).sort()).toEqual(['banner-classic', 'celebration-confetti']);
    const batch = await port.ownedByManagers([ManagerId('m1'), ManagerId('never-bought')]);
    expect(batch.get('m1')!.sort()).toEqual(['banner-classic', 'celebration-confetti']);
    expect(batch.has('never-bought')).toBe(false);
  });
});
