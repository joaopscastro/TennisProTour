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
}
