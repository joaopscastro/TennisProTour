import Fastify, { FastifyInstance } from 'fastify';
import { Dependencies } from './composition';
import { registerPlayerRoutes } from './adapters/inbound/http/playerRoutes';
import { registerTournamentRoutes } from './adapters/inbound/http/tournamentRoutes';

export interface AppOptions {
  deps: Dependencies;
  logger?: boolean;
}

/**
 * Builds the Fastify app with all inbound HTTP adapters registered.
 * Separated from index.ts's listen() so tests can drive the exact
 * production wiring via app.inject() without opening a port.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    // Fastify's built-in pino logger: request/response lines with
    // timing come for free; domain events are logged through the same
    // instance (see index.ts), so one stream carries both.
    logger: options.logger ?? true,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerPlayerRoutes(app, options.deps);
  registerTournamentRoutes(app, options.deps);

  app.setErrorHandler<Error & { statusCode?: number }>((error, request, reply) => {
    // Fastify schema-validation errors arrive with a statusCode; keep it.
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    // Domain/use-case errors are thrown as plain Errors. Provisional
    // mapping until a typed domain-error hierarchy exists: missing
    // aggregates read as 404, every other invariant violation as 409.
    if (/not found/i.test(error.message)) {
      return reply.code(404).send({ error: error.message });
    }
    request.log.warn({ err: error }, 'request rejected by domain rules');
    return reply.code(409).send({ error: error.message });
  });

  return app;
}
