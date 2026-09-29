import { ManagerId, StandardTalentClaimPricingPolicy } from '@tennis-manager/domain';
import { ManagerAccount, ManagerAccountRepository, IdGeneratorPort, ManagerAccountCreationPort } from '../ports/ports';
import { TALENT_POOL_AGE_RANGE } from './talentPoolAgeRange';

export interface EnsureManagerAccountCommand {
  authSubject: string;
  displayName?: string;
  /** Only the explicitly enabled local development adapter may provide this
   * value. Production identities always receive a server-generated ID. */
  developmentManagerId?: ManagerId;
}

/**
 * The flat XP price of the YOUNGEST prospect the talent pool can produce:
 * at `TALENT_POOL_AGE_RANGE.minWeeks` the blended pricing formula is fully
 * flat (`ageInterpolationFactor` = 0 there, so the candidate's rating does
 * not enter the calculation at all — every youngest-age prospect costs the
 * same `StandardTalentClaimPricingPolicy` BASE_COST). Resolved through the
 * REAL pricing policy rather than hard-coded, so this can never drift from
 * what `ClaimTalentPoolCandidateUseCase` actually charges.
 */
export const YOUNGEST_PROSPECT_PRICE_XP = new StandardTalentClaimPricingPolicy().priceFor(
  0, // rating is deliberately irrelevant here — the youngest age prices flat
  TALENT_POOL_AGE_RANGE.minWeeks,
  TALENT_POOL_AGE_RANGE,
);

/**
 * DELIBERATE PRODUCT RULE — not a tuning placeholder. A brand-new manager
 * starts with exactly enough XP to sign TWO youngest-bracket generated
 * prospects, and no more: the onboarding grant is `2 × the flat
 * youngest-prospect price = 2 × 50 = 100 XP` today (the multiplication is
 * derived from the pricing policy above, so the two stay in lockstep).
 *
 * Why exactly two: a newcomer must be able to build a first roster (the
 * free-tier cap is 2 players) from RAW KIDS — the cheapest, least-certain
 * end of the talent pool — and cannot reach a ready-made player instead.
 * There is no third claim and no leftover large enough to matter; a
 * newcomer cannot buy an established or older/stronger player out of the
 * gate. This is the onboarding half of CLAUDE.md principle #1 (money buys
 * convenience, never an unconditional win-rate boost): equal access to
 * the same gambles, not a head start on results.
 *
 * This balance is granted atomically and exactly once per account (see
 * `ManagerAccountCreationPort.createWithStarterXp`): the account row and
 * its opening balance are inserted in a single transaction, gated on a
 * conditional insert, so concurrent first requests can neither double the
 * grant nor observe a transient 0.
 */
export const STARTER_XP_BALANCE = 2 * YOUNGEST_PROSPECT_PRICE_XP;

/** Resolves an authenticated external identity to the application's own
 * manager profile. This is intentionally separate from authentication so
 * Clerk can be replaced without changing ownership checks or community
 * profile data. */
export class EnsureManagerAccountUseCase {
  constructor(
    private readonly managers: ManagerAccountRepository,
    private readonly ids: IdGeneratorPort,
    private readonly accountCreation: ManagerAccountCreationPort,
  ) {}

  async execute(command: EnsureManagerAccountCommand): Promise<ManagerAccount> {
    if (!command.authSubject.trim()) throw new Error('Authenticated subject is required');

    const existing = await this.managers.findByAuthSubject(command.authSubject);
    if (existing) {
      if (existing.status === 'deleted') throw new Error('Manager account has been deleted');
      if (existing.status !== 'active') throw new Error('Manager account is suspended');
      return existing;
    }

    // DeleteManagerAccountUseCase anonymizes authSubject on deletion, so
    // the lookup above never matches a deleted account by its ORIGINAL
    // subject — that's deliberate (it's what lets a real Clerk identity
    // sign up fresh afterward, a new account under a new id). But the
    // development adapter pins a FIXED id from the x-dev-manager-id
    // header (ClerkAuthAdapter/production always mints a fresh random id
    // here instead), so a repeated dev-mode request with the same header
    // after deletion would otherwise fall through to the create path
    // below and silently resurrect the anonymized row under its old id.
    // Guard by id too, but only when a dev id was actually supplied —
    // production never hits this branch.
    if (command.developmentManagerId) {
      const byId = await this.managers.findById(command.developmentManagerId);
      if (byId) {
        if (byId.status === 'deleted') throw new Error('Manager account has been deleted');
        if (byId.status !== 'active') throw new Error('Manager account is suspended');
        return byId;
      }
    }

    const id = command.developmentManagerId ?? ManagerId(this.ids.generate());
    const account: ManagerAccount = {
      id,
      authSubject: command.authSubject,
      displayName: command.displayName?.trim() || 'New manager',
      publicHandle: `manager-${String(id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`,
      status: 'active',
    };
    // Atomic create-and-grant: exactly one concurrent first-request can
    // create the row, and only that one is credited STARTER_XP_BALANCE —
    // the create and the credit happen in a single transaction (see
    // ManagerAccountCreationPort), so a concurrent read can never observe
    // the account before its opening balance exists. When we lose the
    // race the adapter hands back the winner's row, which is what this
    // manager's later requests must see.
    const { account: persisted } = await this.accountCreation.createWithStarterXp(account, STARTER_XP_BALANCE);

    // Defensive: the create path only ever writes an active row, and the
    // pre-checks above catch an existing suspended/deleted account, but a
    // race against one must never slip through as a successful login.
    if (persisted.status === 'deleted') throw new Error('Manager account has been deleted');
    if (persisted.status !== 'active') throw new Error('Manager account is suspended');
    return persisted;
  }
}
