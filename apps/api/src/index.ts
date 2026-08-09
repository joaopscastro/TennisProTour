// Explicit path, not the bare 'dotenv/config' import: that reads .env
// relative to process.cwd(), which happens to be apps/api only when
// launched via `npm run start -w apps/api` — any other launch method
// (e.g. `node dist/index.js` from the repo root, as
// scripts/boot-smoke-test.sh does) would silently see none of .env's
// values. Resolving against __dirname instead makes this independent
// of whatever directory the process was actually started from, and
// points every app at the SAME single repo-root .env (see
// .env.example) rather than each needing its own copy.
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(__dirname, '../../../.env') });

import { createDb } from './db/client';
import { buildDependencies } from './composition';
import { buildApp } from './app';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const port = Number(process.env.PORT ?? 3000);
const matchLogDirectory = process.env.MATCH_LOG_DIR ?? './data/match-logs';

async function main(): Promise<void> {
  const db = createDb(connectionString);

  // Deferred so the app (and its logger) exists before deps that log.
  let app: ReturnType<typeof buildApp>;
  const deps = buildDependencies({
    db,
    matchLogDirectory,
    // Default to this API's own dev blob route so simulate responses
    // return browser-fetchable replay URLs out of the box.
    matchLogPublicBaseUrl: process.env.MATCH_LOG_PUBLIC_BASE_URL ?? `http://localhost:${port}/match-logs`,
    logEvent: (message, payload) => app.log.info(payload, message),
  });
  app = buildApp({ deps, matchLogDirectory });

  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
