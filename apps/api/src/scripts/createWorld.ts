import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Ops-only: stand up world N+1 in one command. Wraps the procedure
 * docs/alpha-runbook.md documents manually:
 *
 *   1. create the database (if it doesn't already exist),
 *   2. run migrations against it,
 *   3. run the real `bootstrapTestWorld` against it (fillers, demo draw,
 *      current-week slate, season calendar, junior ladder),
 *   4. print the exact env needed to start api / worker / web on it.
 *
 * Idempotent: an existing database is left in place and both migrations
 * and the bootstrap are themselves safe to re-run.
 *
 * The bootstrap runs as a CHILD PROCESS (`dist/scripts/bootstrapTestWorld.js`)
 * rather than an in-process import, because `composition.ts` resolves
 * `WORLD_ID` at module-evaluation time — a parent that set
 * `process.env.WORLD_ID` in its own body would be too late for its own
 * already-evaluated imports. A child gets the env before any module loads.
 *
 * Usage (run from the repo root):
 *   npm run create-world -w apps/api -- --world human1 \
 *     [--db-name tennis_manager_human1] [--api-port 3200] [--web-port 3001]
 *
 * The connection host/credentials come from `DATABASE_URL` (default: the
 * local docker-compose Postgres) — only the database name is replaced.
 */

const DEFAULT_DATABASE_URL = 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const DB_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export interface CreateWorldOptions {
  world: string;
  dbName: string;
  databaseUrl: string;
  adminUrl: string;
  apiPort: number;
  webPort: number;
}

/** Same connection string with a different database name — the
 * credentials/host/port are preserved, so operators never retype them. */
export function composeDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function stringArg(raw: Record<string, string>, key: string): string | null {
  const value = raw[key];
  return value !== undefined && value !== 'true' ? value : null;
}

function portArg(raw: Record<string, string>, key: string, fallback: number): number {
  const value = stringArg(raw, key);
  if (value === null) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--${key} must be a port number, got "${value}"`);
  }
  return port;
}

export function resolveCreateWorldOptions(
  argv: string[],
  env: { DATABASE_URL?: string },
): CreateWorldOptions {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      raw[key] = next;
      i += 1;
    } else {
      raw[key] = 'true';
    }
  }

  const world = stringArg(raw, 'world');
  if (!world) {
    throw new Error('--world <id> is required (e.g. --world human1). See docs/alpha-runbook.md.');
  }
  const dbName = stringArg(raw, 'db-name') ?? `tennis_manager_${world}`;
  if (!DB_NAME_PATTERN.test(dbName)) {
    throw new Error(`--db-name "${dbName}" must match ${DB_NAME_PATTERN} (it is used as a SQL identifier)`);
  }

  const baseUrl = env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  return {
    world,
    dbName,
    databaseUrl: composeDatabaseUrl(baseUrl, dbName),
    adminUrl: composeDatabaseUrl(baseUrl, 'postgres'),
    apiPort: portArg(raw, 'api-port', 3200),
    webPort: portArg(raw, 'web-port', 3001),
  };
}

/** CREATE DATABASE if absent. Returns true when it created one. */
async function ensureDatabaseExists(adminUrl: string, dbName: string): Promise<boolean> {
  const client = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount && existing.rowCount > 0) return false;
    await client.query(`CREATE DATABASE "${dbName}"`);
    return true;
  } finally {
    await client.end();
  }
}

async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve(__dirname, '../../drizzle') });
  } finally {
    await pool.end();
  }
}

async function runBootstrap(options: CreateWorldOptions): Promise<void> {
  const script = join(__dirname, 'bootstrapTestWorld.js');
  if (!existsSync(script)) {
    throw new Error(`missing ${script} — build first (npm run build -w apps/api)`);
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script], {
      cwd: resolve(__dirname, '../..'), // apps/api — matches `npm run bootstrap -w apps/api`
      env: {
        ...process.env,
        DATABASE_URL: options.databaseUrl,
        WORLD_ID: options.world,
        AUTH_MODE: 'development',
      },
      stdio: 'inherit',
    });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`bootstrap exited with code ${code}`));
    });
  });
}

function printNextSteps(options: CreateWorldOptions): void {
  const { world, dbName, databaseUrl, apiPort, webPort } = options;
  const lines = [
    '',
    '================= NEXT STEPS =================',
    `World "${world}" is ready in database "${dbName}".`,
    '',
    'api (AUTH_MODE=development = the local x-dev-manager-id path):',
    `  DATABASE_URL=${databaseUrl}`,
    `  WORLD_ID=${world}`,
    '  AUTH_MODE=development',
    `  PORT=${apiPort}`,
    `  CORS_ORIGINS=http://localhost:${webPort}`,
    '  npm run start -w apps/api',
    '',
    'web (build-time NEXT_PUBLIC_* — set before `next dev`/`next build`):',
    `  NEXT_PUBLIC_API_URL=http://localhost:${apiPort}`,
    '  NEXT_PUBLIC_DEV_MANAGER_ID=<your-manager-id>',
    `  npx next dev -p ${webPort}   (from apps/web)`,
    '',
    'worker (ONLY if you want the scheduled world tick — a harness that',
    'drives its own day ticks, like agentSeason.mjs, must NOT run one):',
    `  DATABASE_URL=${databaseUrl}`,
    `  WORLD_ID=${world}`,
    '  REDIS_URL=redis://localhost:6379',
    '  npm run start -w apps/worker',
    '',
    'Reminder: every process for this world must see the SAME WORLD_ID.',
    '==============================================',
    '',
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const options = resolveCreateWorldOptions(process.argv.slice(2), process.env);
  // eslint-disable-next-line no-console
  console.log(`[create-world] world "${options.world}" → database "${options.dbName}"`);
  const created = await ensureDatabaseExists(options.adminUrl, options.dbName);
  // eslint-disable-next-line no-console
  console.log(created ? `[create-world] created database ${options.dbName}` : `[create-world] database ${options.dbName} already exists`);
  await runMigrations(options.databaseUrl);
  // eslint-disable-next-line no-console
  console.log('[create-world] migrations applied');
  await runBootstrap(options);
  printNextSteps(options);
}

const isDirectRun = typeof require !== 'undefined' && require.main === module;

if (isDirectRun) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
