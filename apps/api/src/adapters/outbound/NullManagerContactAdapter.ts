import { ManagerId } from '@tennis-manager/domain';
import { ManagerContactPort } from '@tennis-manager/application';

/**
 * Notifications bounded context (STAGE 2) — the contact resolver for
 * the `off` and `log` email modes.
 *
 * Always returns null for every manager, which makes the digest use
 * case skip without claiming. With no real transport configured there
 * is no point resolving an address, and (more importantly) returning
 * null keeps the fail-safe behavior: an unconfigured deployment can
 * never accidentally send through a half-wired path. Only `resend` mode
 * swaps in the real Clerk-backed resolver.
 */
export class NullManagerContactAdapter implements ManagerContactPort {
  async emailFor(_managerId: ManagerId): Promise<string | null> {
    return null;
  }
}
