import { verifyToken } from '@clerk/backend';
import { AuthPort } from '@tennis-manager/application';

export class ClerkAuthAdapter implements AuthPort {
  constructor(
    private readonly secretKey: string,
    private readonly authorizedParties: string[],
  ) {}

  async verifyAccessToken(accessToken: string): Promise<{ subject: string; displayName?: string } | null> {
    try {
      const payload = await verifyToken(accessToken, {
        secretKey: this.secretKey,
        authorizedParties: this.authorizedParties.length > 0 ? this.authorizedParties : undefined,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
      return {
        subject: payload.sub,
        displayName: typeof payload.name === 'string' ? payload.name : undefined,
      };
    } catch {
      return null;
    }
  }
}

export class DevelopmentAuthAdapter implements AuthPort {
  async verifyAccessToken(accessToken: string): Promise<{ subject: string; displayName?: string } | null> {
    if (!accessToken.startsWith('dev:')) return null;
    const managerId = accessToken.slice('dev:'.length).trim();
    return managerId ? { subject: `dev:${managerId}`, displayName: managerId } : null;
  }
}
