import { ManagerId } from '@tennis-manager/domain';
import { cosmeticById } from '@tennis-manager/domain';
import { ManagerCosmeticPort } from '../ports/ports';

export interface PurchaseManagerCosmeticCommand {
  managerId: ManagerId;
  /** The catalog item id to buy. The PRICE is always looked up from the
   * catalog here — never accepted from the caller — so a client can
   * never choose what an item costs. */
  itemId: string;
}

export interface PurchaseManagerCosmeticResult {
  itemId: string;
  xpSpent: number;
}

/**
 * Buys one cosmetic item with manager XP (Batch 4B, F2 — the
 * zero-competitive-effect XP sink; see domain ManagerCosmetics.ts for
 * the catalog, the PLACEHOLDER prices, and the explicit statement that
 * XP → player development/training/fatigue purchases were deliberately
 * rejected as win-rate-buying scope).
 *
 * The unknown-item refusal happens here, against the catalog, BEFORE the
 * port is called; the atomic debit+unlock happens inside the port. The
 * two honest refusals are thrown as plain errors so the global handler
 * maps them to 409s, the same convention every other invariant
 * violation in this codebase follows.
 */
export class PurchaseManagerCosmeticUseCase {
  constructor(private readonly managerCosmetics: ManagerCosmeticPort) {}

  async execute(command: PurchaseManagerCosmeticCommand): Promise<PurchaseManagerCosmeticResult> {
    const item = cosmeticById(command.itemId);
    if (!item) {
      throw new Error(`Unknown cosmetic item "${command.itemId}"`);
    }

    const outcome = await this.managerCosmetics.purchaseAndCharge({
      managerId: command.managerId,
      itemId: item.id,
      xpCost: item.price,
    });

    if (outcome.kind === 'already-owned') {
      throw new Error(`Cosmetic "${item.name}" is already owned`);
    }
    if (outcome.kind === 'insufficient-xp') {
      throw new Error(
        `Insufficient XP to buy "${item.name}": needs ${outcome.required}, balance ${outcome.balance}`,
      );
    }
    return { itemId: item.id, xpSpent: outcome.xpSpent };
  }
}
