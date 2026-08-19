import { FastifyReply, FastifyRequest } from 'fastify';
import { ManagerId } from '@tennis-manager/domain';
import { ManagerAccount } from '@tennis-manager/application';
import { Dependencies } from '../../../composition';

/** Resolves the request to an application-owned manager. Production never
 * accepts a manager ID from a body, path, or development header. */
export async function requireManager(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Dependencies,
): Promise<ManagerAccount | null> {
  const authorization = request.headers.authorization;
  let accessToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
  let developmentManagerId: string | undefined;

  if (!accessToken && deps.authMode === 'development') {
    const header = request.headers['x-dev-manager-id'];
    const value = typeof header === 'string' && header.trim() ? header.trim() : undefined;
    if (value) {
      developmentManagerId = value;
      accessToken = `dev:${developmentManagerId}`;
    }
  }

  if (!accessToken) {
    await reply.code(401).send({ error: 'Authentication required' });
    return null;
  }

  const identity = await deps.auth.verifyAccessToken(accessToken);
  if (!identity) {
    await reply.code(401).send({ error: 'Invalid authentication' });
    return null;
  }

  try {
    return await deps.ensureManagerAccount.execute({
      authSubject: identity.subject,
      displayName: identity.displayName,
      developmentManagerId: developmentManagerId ? ManagerId(developmentManagerId) : undefined,
    });
  } catch (error) {
    if (error instanceof Error && (error.message === 'Manager account is suspended' || error.message === 'Manager account has been deleted')) {
      await reply.code(403).send({ error: error.message });
      return null;
    }
    throw error;
  }
}

export function ownershipMismatch(requestedManagerId: string, manager: ManagerAccount): boolean {
  return requestedManagerId !== manager.id;
}

/** Tournament creation is an operator/worker action, not a manager action.
 * It uses a separate server-to-server secret until a real admin context is
 * introduced. Never expose this token to the browser. */
export async function requireInternalAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const configured = process.env.INTERNAL_ADMIN_TOKEN;
  const provided = request.headers['x-internal-admin-token'];
  if (!configured || typeof provided !== 'string' || provided !== configured) {
    await reply.code(403).send({ error: 'Administrative authorization required' });
    return false;
  }
  return true;
}
