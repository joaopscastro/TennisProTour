import { ManagerId } from '@tennis-manager/domain';
import { ManagerAccount, ManagerAccountRepository, IdGeneratorPort, ManagerXpRepository } from '../ports/ports';

export interface EnsureManagerAccountCommand {
  authSubject: string;
  displayName?: string;
  /** Only the explicitly enabled local development adapter may provide this
   * value. Production identities always receive a server-generated ID. */
  developmentManagerId?: ManagerId;
}

/**
 * PLACEHOLDER starter XP a brand-new manager is granted the moment their
 * account is created — the onboarding fix. Without it a fresh account has
 * 0 XP, every talent-pool claim costs ≥50 XP, and XP is only ever earned
 * from match results, so a new manager literally could not acquire their
 * first player. 500 is enough to sign one or two free agents (the
 * youngest cost ~50 XP, a strong prime-age prospect ~150-250) so a new
 * manager has a real choice, without being so generous it buys an elite
 * roster outright — this is a start, not a leg-up (CLAUDE.md principle
 * #1). Not tuned; flagged like every other placeholder.
 */
export const STARTER_XP_BALANCE = 500;

/** Resolves an authenticated external identity to the application's own
 * manager profile. This is intentionally separate from authentication so
 * Clerk can be replaced without changing ownership checks or community
 * profile data. */
export class EnsureManagerAccountUseCase {
  constructor(
    private readonly managers: ManagerAccountRepository,
    private readonly ids: IdGeneratorPort,
    private readonly managerXp: ManagerXpRepository,
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
    // after deletion would otherwise fall through to
    // managers.save()'s upsert-by-id below and silently resurrect the
    // anonymized row under its old id. Guard by id too, but only when a
    // dev id was actually supplied — production never hits this branch.
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
    await this.managers.save(account);
    // Onboarding grant — only on genuine creation (every existing-account
    // path above returns early), so a returning manager never re-gets it.
    // A concurrent first-request race could double it; a few hundred XP
    // is a negligible, self-correcting edge, not worth a transactional
    // insert for.
    await this.managerXp.credit(account.id, STARTER_XP_BALANCE);
    return account;
  }
}
