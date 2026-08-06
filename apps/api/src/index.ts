import 'dotenv/config';
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
