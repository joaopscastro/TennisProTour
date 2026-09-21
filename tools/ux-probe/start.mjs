#!/usr/bin/env node
/**
 * ux-probe bring-up — prepares an ISOLATED world and starts N independent
 * "naive visitor" sessions, then exits leaving everything running.
 *
 * What it does, in order (see tools/ux-probe/README.md for the operator view):
 *   1. `docker compose up -d --wait` (Postgres + Redis).
 *   2. Build the TypeScript packages.
 *   3. Create + migrate a DEDICATED database (`tennis_manager_ux` by default).
 *      `players`/`tournaments` carry no world_id, so a separate database —
 *      not `WORLD_ID=ux` alone — is what actually isolates this run from dev
 *      and soak data.
 *   4. With NO worker running: bootstrap the world (`WORLD_ID=ux`), then drive
 *      a handful of synthetic day ticks with the real day-tick handler
 *      (`apps/worker/dist/scripts/soakTick.js`) so the demo draw has decided
 *      matches and the world looks lived-in.
 *   5. Start the API (`WORLD_ID=ux`, `AUTH_MODE=development`) on its own port.
 *   6. Start N `next dev` servers on distinct ports, EACH with its own
 *      `NEXT_PUBLIC_DEV_MANAGER_ID` and its own `distDir` (Next refuses two
 *      dev servers on one distDir). The dev-manager id is inlined into the
 *      client bundle at server start, so this is what gives each naive agent
 *      a stable, separate identity.
 *   7. Start N ux-probe driver processes, one per session, each pointed at its
 *      own web server.
 *   8. Print a table and write `.sessions/sessions.json`.
 *
 * The worker is deliberately never started, so the world does not mutate
 * under the agents mid-session.
 *
 * Stop everything with: `node tools/ux-probe/stop.mjs`
 *
 * Env overrides (all optional):
 *   UX_SESSIONS           number of sessions (default 4)
 *   UX_DB_NAME            database name (default tennis_manager_ux)
 *   UX_WORLD_ID           world id (default ux)
 *   UX_PG_BASE            postgres base URL (default postgresql://tennis:tennis@localhost:5432)
 *   UX_API_PORT           first API port to try (default 3000)
 *   UX_WEB_PORT_BASE      web ports start here (default 3001)
 *   UX_DRIVER_PORT_BASE   driver ports start here (default 4001)
 *   UX_TICKS              synthetic day ticks to drive (default 10)
 *   UX_MANAGER_PREFIX     dev-manager id prefix (default ux-agent)
 *   UX_SKIP_SETUP=1       skip docker/build/migrate/bootstrap/ticks
 *   UX_HEADED=1           run driver browsers headed (default headless)
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SESSIONS_ROOT = resolve(__dirname, '.sessions');
const LOGS_DIR = resolve(SESSIONS_ROOT, 'logs');

const SESSIONS = Number(process.env.UX_SESSIONS ?? 4);
const DB_NAME = process.env.UX_DB_NAME ?? 'tennis_manager_ux';
const WORLD_ID = process.env.UX_WORLD_ID ?? 'ux';
const PG_BASE = process.env.UX_PG_BASE ?? 'postgresql://tennis:tennis@localhost:5432';
const API_PORT_BASE = Number(process.env.UX_API_PORT ?? 3000);
const WEB_PORT_BASE = Number(process.env.UX_WEB_PORT_BASE ?? 3001);
const DRIVER_PORT_BASE = Number(process.env.UX_DRIVER_PORT_BASE ?? 4001);
const TICKS = Number(process.env.UX_TICKS ?? 10);
const MANAGER_PREFIX = process.env.UX_MANAGER_PREFIX ?? 'ux-agent';
const SKIP_SETUP = process.env.UX_SKIP_SETUP === '1';
const HEADED = process.env.UX_HEADED === '1';

const DB_URL = `${PG_BASE}/${DB_NAME}`;
const NEXT_BIN = join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Small process/port/db helpers (plain Node, cross-platform)
// ---------------------------------------------------------------------------
function runOrDie(label, command, args, options = {}) {
  console.log(`\n==> ${label}\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) {
    console.error(`\nFailed to run "${command}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n"${command} ${args.join(' ')}" exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/** Runs an `npm`/`docker`/`npx` shim, which needs a shell on Windows (.cmd). */
function runShellOrDie(label, command, args, options = {}) {
  console.log(`\n==> ${label}\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true, ...options });
  if (result.error || result.status !== 0) {
    console.error(`\n"${command} ${args.join(' ')}" ${result.error ? result.error.message : `exited with code ${result.status}`}`);
    process.exit(result.status ?? 1);
  }
}

async function portFree(port) {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolvePromise(false));
    // `0.0.0.0` explicitly — the exact host apps/api binds. On Windows an
    // IPv6/`::` or `127.0.0.1` probe can succeed even while another process
    // holds `0.0.0.0:<port>`, which is exactly how a probe once "reserved" a
    // port that apps/api then failed to bind with EADDRINUSE.
    server.listen(port, '0.0.0.0', () => server.close(() => resolvePromise(true)));
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns `count` free ports starting from `start`, skipping anything busy. */
async function pickPorts(start, count) {
  const ports = [];
  let port = start;
  while (ports.length < count && port < start + 200) {
    if (await portFree(port)) ports.push(port);
    port += 1;
  }
  if (ports.length < count) throw new Error(`could not find ${count} free ports from ${start}`);
  return ports;
}

async function ensureDatabase() {
  const admin = new pg.Client({ connectionString: `${PG_BASE}/postgres` });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (rowCount && rowCount > 0) {
      console.log(`==> Database "${DB_NAME}" already exists.`);
      return;
    }
    console.log(`==> Creating isolated database "${DB_NAME}"...`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end();
  }
}

function spawnDetached({ name, command, args, cwd, env, logFile }) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  console.log(`==> ${name} started (pid ${child.pid}) → ${logFile}`);
  return child.pid;
}

async function httpOk(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label, url, timeoutMs, pid) {
  // Give a just-spawned process a moment to fail loudly (e.g. EADDRINUSE
  // exits within milliseconds) before we trust a response from the port —
  // otherwise a stale listener on the same port can answer in the gap.
  await sleep(700);
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    // A dead process can never become ready; fail fast instead of waiting for
    // an unrelated listener on the same port to answer (that exact confusion
    // once let a stale dev API masquerade as this run's isolated API).
    if (pid && !pidAlive(pid)) {
      throw new Error(`${label} process (pid ${pid}) exited before becoming ready at ${url}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log(`==> ${label} is ready (${url}).`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms (last: ${lastError})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!SKIP_SETUP) {
    // 1. Infra
    runShellOrDie('Starting Postgres + Redis', 'docker', ['compose', 'up', '-d', '--wait'], { cwd: REPO_ROOT });

    // 2. Build
    runShellOrDie('Building TypeScript packages', 'npx', ['tsc', '--build'], { cwd: REPO_ROOT });

    // 3. Dedicated database + migrations
    await ensureDatabase();
    runShellOrDie('Applying migrations to the isolated database', 'npm', ['run', 'db:migrate', '-w', 'apps/api'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: DB_URL },
    });

    // 4. Bootstrap + synthetic day ticks (no worker running)
    const scriptEnv = { ...process.env, DATABASE_URL: DB_URL, WORLD_ID, AUTH_MODE: 'development' };
    runOrDie('Bootstrapping the ux world', 'node', [join(REPO_ROOT, 'apps', 'api', 'dist', 'scripts', 'bootstrapTestWorld.js')], {
      cwd: REPO_ROOT,
      env: scriptEnv,
    });
    runOrDie(`Driving ${TICKS} synthetic day tick(s) so the world looks lived-in`, 'node', [
      join(REPO_ROOT, 'apps', 'worker', 'dist', 'scripts', 'soakTick.js'),
      '--ticks',
      String(TICKS),
      '--start',
      '0',
    ], { cwd: REPO_ROOT, env: scriptEnv });
  } else {
    console.log('==> UX_SKIP_SETUP=1 — skipping docker/build/migrate/bootstrap/ticks.');
  }

  mkdirSync(LOGS_DIR, { recursive: true });

  // 5. API
  const [apiPort] = await pickPorts(API_PORT_BASE, 1);
  const sessionCount = Math.max(1, SESSIONS);

  // Picked before the API binds (CORS needs the web origins up front), but
  // the API port is filtered out so the two can never land on the same one.
  const webPortCandidates = await pickPorts(WEB_PORT_BASE, sessionCount + 1);
  const webPorts = webPortCandidates.filter((p) => p !== apiPort).slice(0, sessionCount);
  if (webPorts.length < sessionCount) throw new Error('could not reserve distinct web ports');

  const webUrls = webPorts.map((p) => `http://localhost:${p}`);
  const apiEnv = {
    ...process.env,
    DATABASE_URL: DB_URL,
    WORLD_ID,
    AUTH_MODE: 'development',
    NODE_ENV: 'development',
    PORT: String(apiPort),
    CORS_ORIGINS: webUrls.join(','),
    // Force cron mode (no live countdown to a tick that will never fire while
    // the worker is stopped) — an empty value wins over .env's setting.
    WORLD_TICK_INTERVAL_MS: '',
    MATCH_LOG_PUBLIC_BASE_URL: `http://localhost:${apiPort}/match-logs`,
    NOTIFICATION_EMAIL_MODE: 'off',
  };
  const apiPid = spawnDetached({
    name: `API (world=${WORLD_ID}, db=${DB_NAME})`,
    command: 'node',
    args: [join(REPO_ROOT, 'apps', 'api', 'dist', 'index.js')],
    cwd: REPO_ROOT,
    env: apiEnv,
    logFile: join(LOGS_DIR, 'api.log'),
  });
  await waitFor('API', `http://localhost:${apiPort}/health`, 60_000, apiPid);

  // 6. Web dev servers — one per session, each with its own identity + distDir.
  //
  // Next.js rewrites `apps/web/tsconfig.json`'s `include` to add its own
  // `distDir` type globs at every dev-server boot. With one distDir per
  // session that would leave the tracked tsconfig with a set of port-specific
  // entries (and churn on every run), so we snapshot it here and restore it
  // once every server is up. Runtime is unaffected — the rewrite only feeds
  // Next's own typechecking, which has already run by the time a server is
  // listening.
  const tsconfigPath = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
  let tsconfigBackup = null;
  try {
    tsconfigBackup = readFileSync(tsconfigPath);
  } catch {
    tsconfigBackup = null;
  }
  // Driver ports are picked free too, so a stray listener can't collide.
  const driverPorts = await pickPorts(DRIVER_PORT_BASE, sessionCount);
  const sessions = [];
  for (let i = 0; i < sessionCount; i++) {
    const sessionId = `${MANAGER_PREFIX}-${i + 1}`;
    const managerId = sessionId;
    const webPort = webPorts[i];
    const webUrl = `http://localhost:${webPort}`;
    const driverPort = driverPorts[i];
    const sessionDir = resolve(SESSIONS_ROOT, sessionId);

    const webEnv = {
      ...process.env,
      NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`,
      NEXT_PUBLIC_AUTH_MODE: 'development',
      // Force the local dev-identity path; an empty value beats any inherited key.
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
      NEXT_PUBLIC_DEV_MANAGER_ID: managerId,
      NEXT_DIST_DIR: `.next-ux-${webPort}`,
    };
    const webPid = spawnDetached({
      name: `web ${sessionId}`,
      command: 'node',
      args: [NEXT_BIN, 'dev', '-p', String(webPort)],
      cwd: join(REPO_ROOT, 'apps', 'web'),
      env: webEnv,
      logFile: join(LOGS_DIR, `${sessionId}.web.log`),
    });

    sessions.push({ sessionId, managerId, webPort, webUrl, driverPort, sessionDir, webPid, driverPid: null });
  }

  // Wait for every web server (first dev compile can be slow).
  for (const session of sessions) {
    await waitFor(`web ${session.sessionId}`, session.webUrl, 240_000, session.webPid);
  }
  if (tsconfigBackup) {
    writeFileSync(tsconfigPath, tsconfigBackup);
    console.log('==> Restored apps/web/tsconfig.json after Next dev distDir rewrites.');
  }

  // 7. One driver per session (fresh session dir each run, so screenshots
  // and journals never mix evidence between runs).
  for (const session of sessions) {
    rmSync(session.sessionDir, { recursive: true, force: true });
    const driverPid = spawnDetached({
      name: `driver ${session.sessionId}`,
      command: 'node',
      args: [
        join(__dirname, 'driver.mjs'),
        '--port',
        String(session.driverPort),
        '--web-url',
        session.webUrl,
        '--session-id',
        session.sessionId,
        '--session-dir',
        session.sessionDir,
        ...(HEADED ? ['--headed'] : []),
      ],
      cwd: REPO_ROOT,
      env: { ...process.env, UX_DRIVER_PORT: String(session.driverPort), UX_WEB_URL: session.webUrl, UX_SESSION_ID: session.sessionId },
      logFile: join(LOGS_DIR, `${session.sessionId}.driver.log`),
    });
    session.driverPid = driverPid;
  }
  for (const session of sessions) {
    await waitFor(`driver ${session.sessionId}`, `http://localhost:${session.driverPort}/health`, 90_000, session.driverPid);
  }

  // 8. Persist metadata + print the table.
  const manifest = {
    startedAt: new Date().toISOString(),
    apiUrl: `http://localhost:${apiPort}`,
    apiPort,
    apiPid,
    database: DB_NAME,
    worldId: WORLD_ID,
    ticks: TICKS,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      managerId: s.managerId,
      webUrl: s.webUrl,
      driverUrl: `http://localhost:${s.driverPort}`,
      webPid: s.webPid,
      driverPid: s.driverPid,
    })),
  };
  writeFileSync(resolve(SESSIONS_ROOT, 'sessions.json'), JSON.stringify(manifest, null, 2));

  const rows = sessions.map((s) => ({
    sessionId: s.sessionId,
    managerId: s.managerId,
    webUrl: s.webUrl,
    driverUrl: `http://localhost:${s.driverPort}`,
  }));
  console.log('\n============================================================');
  console.log(' ux-probe sessions are UP (worker intentionally stopped)');
  console.log('============================================================');
  console.table(rows);
  console.log(`\nAPI:      http://localhost:${apiPort}  (world=${WORLD_ID}, db=${DB_NAME})`);
  console.log(`Metadata: ${resolve(SESSIONS_ROOT, 'sessions.json')}`);
  console.log(`Logs:     ${LOGS_DIR}`);
  console.log('\nHealth-check a session:  curl ' + rows[0].driverUrl + '/health');
  console.log('Stop everything:         node tools/ux-probe/stop.mjs');
  console.log('============================================================\n');
}

main().catch((error) => {
  console.error('\nux-probe bring-up failed:');
  console.error(error);
  process.exit(1);
});
