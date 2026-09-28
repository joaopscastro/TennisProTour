/**
 * Runner resilience helpers for the agent-played-season harness
 * (`agentSeason.mjs`) — extracted pure/fs-scoped functions so they are
 * unit-testable without importing the runner module (which executes
 * `main()` on import).
 *
 * Two real incidents drive this file:
 *
 *   1. **A stale `.tmp` after a crash.** `writeJsonAtomic` writes
 *      `<file>.tmp-<pid>-<timestamp>` then renames; a process killed
 *      between those two steps leaves the temp file behind (observed
 *      live: `weeks/week-039/state.json.tmp-19232-…` after the runner
 *      crashed mid-collect). The final file is usually still intact, but
 *      a crash before the FIRST write of a file (or after a partial
 *      write that somehow landed on the real name) can leave only the
 *      temp copy. `readJsonWithTmpFallback` recovers from exactly that,
 *      and `cleanupRunnerTempFiles` removes the orphans at boot (after
 *      the run lock is held, so no live writer can be mid-rename).
 *      Deliberately SCOPED to runner-owned files (run/report/CURRENT/
 *      LOCK/week state): agent decision files use the same atomic-write
 *      pattern from `agentWeek.mjs`, and deleting an agent's in-flight
 *      temp could break their `write` command.
 *
 *   2. **No supervisor.** The runner process died and the world sat
 *      stalled until a human restarted it from the run.json args (the
 *      harness's own resume path — see `main()`). `decideSupervisorAction`
 *      is the pure decision behind the `--supervise` wrapper: restart on
 *      an UNEXPECTED exit (code 1), stop on a clean exit (0) or a
 *      deliberate `StopRunError` (3) — retrying a deliberate stop
 *      (lock conflict, live tick driver detected, bad config) would just
 *      loop.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Parse `file`, or — when it is missing/unparseable — the newest valid
 * sibling `<file>.tmp-*` left by an interrupted atomic write. Returns
 * null when neither is parseable. */
export function readJsonWithTmpFallback(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* fall through to the newest temp sibling */
  }
  const dir = dirname(file);
  if (!existsSync(dir)) return null;
  const prefix = `${basename(file)}.tmp-`;
  const temps = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse(); // pid+timestamp names: newest last, reversed here
  for (const name of temps) {
    try {
      return JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      /* try an older one */
    }
  }
  return null;
}

/** Removes orphaned `<file>.tmp-*` files for every RUNNER-owned state
 * file under `runDir` (top level + one `weeks/* /` level). Returns the
 * removed paths. Best-effort: a failed unlink is skipped, never fatal. */
export function cleanupRunnerTempFiles(runDir) {
  const removed = [];
  const removeMatches = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        rmSync(join(dir, name), { force: true });
        removed.push(join(dir, name));
      } catch {
        /* best effort */
      }
    }
  };
  for (const name of ['run.json', 'report.json', 'CURRENT.json', 'LOCK.json']) {
    removeMatches(runDir, `${name}.tmp-`);
  }
  const weeksDir = join(runDir, 'weeks');
  if (existsSync(weeksDir)) {
    for (const entry of readdirSync(weeksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      removeMatches(join(weeksDir, entry.name), 'state.json.tmp-');
    }
  }
  return removed;
}

/** How many restarts the `--supervise` wrapper will perform before giving
 * up and exiting (so a permanently-broken environment does not loop
 * forever). The runner resumes from the filesystem on every restart, so
 * each one is cheap and idempotent. */
export const MAX_SUPERVISOR_RESTARTS = 10;

/** The pure supervisor decision: restart only an UNEXPECTED exit. Exit 0
 * is a clean stop (a graceful `--stop-after-day` or a completed run);
 * exit 3 is a deliberate `StopRunError` (lock held by another runner, a
 * live tick driver detected, invalid config) — retrying either would
 * just repeat the same outcome. */
export function decideSupervisorAction(exitCode) {
  if (exitCode === 0) return { action: 'stop', reason: 'clean exit (stopped or complete)' };
  if (exitCode === 3) return { action: 'stop', reason: 'deliberate stop — fix the cause, then rerun' };
  return { action: 'restart', reason: `unexpected exit code ${exitCode}` };
}
