import { FastifyInstance } from 'fastify';
import { Dependencies } from '../../../composition';
import { requireManager } from './auth';

export function registerAuthRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get('/auth/me', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    return {
      id: manager.id,
      displayName: manager.displayName,
      publicHandle: manager.publicHandle,
    };
  });

  // Self-service account deletion (docs/security-and-identity.md's
  // production checklist). Releases every rostered player (their game
  // history — ranking ledger, titles, peaks — survives, unowned, exactly
  // like any other release) then anonymizes the manager row. No body
  // needed: a manager can only ever delete their own account, resolved
  // from the auth token, never from a path/body-supplied id.
  app.delete('/me/account', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    await deps.deleteManagerAccount.execute({ managerId: manager.id });
    return reply.code(204).send();
  });
}
