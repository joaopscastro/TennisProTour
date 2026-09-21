#!/usr/bin/env node
/**
 * ux-probe teardown — stops every process `start.mjs` left running.
 *
 * Reads `.sessions/sessions.json`, kills each API / web / driver process tree,
 * and reports what it did. Pass `--clean` to also delete the `.sessions`
 * directory (screenshots, journals, browser profiles, logs). The isolated
 * database is deliberately left alone so a re-run against it is fast and
 * idempotent; drop it yourself with `DROP DATABASE tennis_manager_ux` if you
 * want a truly clean slate.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_ROOT = resolve(__dirname, '.sessions');
const MANIFEST = resolve(SESSIONS_ROOT, 'sessions.json');
const clean = process.argv.includes('--clean');

function killTree(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return result.status === 0;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

if (!existsSync(MANIFEST)) {
  console.log(`No ${MANIFEST} — nothing to stop.`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const stopped = [];

for (const session of manifest.sessions ?? []) {
  if (killTree(session.driverPid)) stopped.push(`driver ${session.sessionId} (pid ${session.driverPid})`);
  if (killTree(session.webPid)) stopped.push(`web ${session.sessionId} (pid ${session.webPid})`);
}
if (killTree(manifest.apiPid)) stopped.push(`api (pid ${manifest.apiPid})`);

console.log(stopped.length > 0 ? `Stopped:\n  ${stopped.join('\n  ')}` : 'Nothing was running.');

if (clean) {
  rmSync(SESSIONS_ROOT, { recursive: true, force: true });
  console.log(`Removed ${SESSIONS_ROOT}.`);
} else {
  console.log('Session artifacts kept in .sessions/ (use --clean to remove them).');
}
