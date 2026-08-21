import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Dependencies } from './composition';
import { registerPlayerRoutes } from './adapters/inbound/http/playerRoutes';
import { registerTournamentRoutes } from './adapters/inbound/http/tournamentRoutes';
import { registerBillingRoutes } from './adapters/inbound/http/billingRoutes';
import { registerTalentPoolRoutes } from './adapters/inbound/http/talentPoolRoutes';
import { registerAuthRoutes } from './adapters/inbound/http/authRoutes';
import { registerWorldRoutes } from './adapters/inbound/http/worldRoutes';
import { registerManagerRoutes } from './adapters/inbound/http/managerRoutes';
import { registerDoublesRoutes } from './adapters/inbound/http/doublesRoutes';
import { registerMastersCupRoutes } from './adapters/inbound/http/mastersCupRoutes';
import { registerWorldTeamCupRoutes } from './adapters/inbound/http/worldTeamCupRoutes';
import { registerRankingsRoutes } from './adapters/inbound/http/rankingsRoutes';

export interface AppOptions {
  deps: Dependencies;
  /** Where FilesystemMatchLogStore writes blobs; served read-only at
   * GET /match-logs/:file in dev (a CDN does this job in production). */
  matchLogDirectory: string;
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

  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  // @fastify/cors defaults `methods` to 'GET,HEAD,POST' when not set
  // explicitly — silently blocking every other verb at the browser's
  // preflight check even though the route itself exists server-side
  // (integration tests using undici/node-fetch don't enforce CORS, so
  // this stayed invisible until exercised from a real browser). The
  // training-focus PUT endpoint was blocked by exactly this before it
  // was found and fixed here.
  app.register(cors, { origin: allowedOrigins, credentials: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  app.register(helmet);
  app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/health', async () => ({ status: 'ok' }));

  // Self-maintaining API discoverability (no OpenAPI/swagger package in
  // this codebase, and a hand-maintained list would drift the moment a
  // route was added or renamed — an extended LLM-manager playtest hit
  // exactly this: an API-cold client had no way to enumerate what
  // existed short of reading source). Fastify's `onRoute` lifecycle hook
  // fires once per route as it's registered, so this list can never go
  // stale — it's collected from the same registration calls that make
  // the routes real, not maintained separately. Registered before the
  // route modules below so it catches every one of them, itself
  // included (it fires again for this very GET /routes call).
  const routeList: Array<{ method: string; url: string }> = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routeList.push({ method, url: route.url });
    }
  });
  app.get('/routes', async () =>
    [...routeList].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method)),
  );

  // Dev-mode stand-in for the CDN in front of object storage: serve
  // the immutable replay blobs FilesystemMatchLogStore wrote. Reads
  // only — nothing here can create or mutate a blob.
  app.get<{ Params: { file: string } }>(
    '/match-logs/:file',
    { schema: { params: { type: 'object', properties: { file: { type: 'string', pattern: '^[A-Za-z0-9_-]+\\.json$' } } } } },
    async (request, reply) => {
      try {
        const blob = await readFile(join(options.matchLogDirectory, request.params.file), 'utf8');
        return reply
          .header('content-type', 'application/json')
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(blob);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.code(404).send({ error: `Replay ${request.params.file} not found` });
        }
        throw error;
      }
    },
  );

  registerPlayerRoutes(app, options.deps);
  registerTournamentRoutes(app, options.deps);
  registerBillingRoutes(app, options.deps);
  registerTalentPoolRoutes(app, options.deps);
  registerAuthRoutes(app, options.deps);
  registerWorldRoutes(app, options.deps);
  registerManagerRoutes(app, options.deps);
  registerDoublesRoutes(app, options.deps);
  registerMastersCupRoutes(app, options.deps);
  registerWorldTeamCupRoutes(app, options.deps);
  registerRankingsRoutes(app, options.deps);

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
