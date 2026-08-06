import { ManagerId } from '@tennis-manager/domain';
import { ManagerAccount, ManagerAccountRepository, IdGeneratorPort } from '../ports/ports';

export interface EnsureManagerAccountCommand {
  authSubject: string;
  displayName?: string;
  /** Only the explicitly enabled local development adapter may provide this
   * value. Production identities always receive a server-generated ID. */
  developmentManagerId?: ManagerId;
}

/** Resolves an authenticated external identity to the application's own
 * manager profile. This is intentionally separate from authentication so
 * Clerk can be replaced without changing ownership checks or community
 * profile data. */
export class EnsureManagerAccountUseCase {
  constructor(
    private readonly managers: ManagerAccountRepository,
    private readonly ids: IdGeneratorPort,
  ) {}

  async execute(command: EnsureManagerAccountCommand): Promise<ManagerAccount> {
    if (!command.authSubject.trim()) throw new Error('Authenticated subject is required');

    const existing = await this.managers.findByAuthSubject(command.authSubject);
    if (existing) {
      if (existing.status !== 'active') throw new Error('Manager account is suspended');
      return existing;
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
    return account;
  }
}
