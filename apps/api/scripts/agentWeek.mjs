#!/usr/bin/env node
/**
 * The agent-facing CLI for the agent-played-season harness.
 *
 * An LLM agent NEVER talks to the game API — the runner
 * (`agentSeason.mjs`) issues every HTTP call on the agent's behalf. This
 * CLI is the agent's whole interface to the runner:
 *
 *   ready  — marks this agent ready for the current week (creates
 *            `agents/<managerId>/.ready`). Called once at boot.
 *   status — prints the current week/phase/paths as JSON. Exit codes:
 *              0  decide now (read the digest, write a decision)
 *              10 you already submitted this week (wait)
 *              11 the world is advancing / the run is complete (wait)
 *   write  — validates a draft decision (shared schema, same validator
 *            the runner uses) and lands it atomically. Exit 0 accepted,
 *            2 schema errors (fix + retry), 3 the decision window has
 *            already closed.
 *
 * Usage:
 *   node apps/api/scripts/agentWeek.mjs ready  --run runs/<runId> --manager agent-m1
 *   node apps/api/scripts/agentWeek.mjs status --run runs/<runId> --manager agent-m1
 *   node apps/api/scripts/agentWeek.mjs write  --run runs/<runId> --manager agent-m1 --file <draft.json>
 *
 * `--run` / `--manager` may be omitted when the environment provides
 * `AGENT_RUN_DIR` / `AGENT_MANAGER_ID`, or when the repo's `runs/`
 * directory holds exactly one run / the run holds exactly one agent.
 * Every printed path is absolute, so an agent never has to guess.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatValidationErrors, validateDecision } from './lib/decisionSchema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const RUNS_ROOT = join(REPO_ROOT, 'runs');

const EXIT_DECIDE = 0;
const EXIT_ALREADY = 10;
const EXIT_ADVANCING = 11;

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { command: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--') && args.command === null) {
      args.command = token;
    } else if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next;
        i += 1;
      } else {
        args.flags[key] = true;
      }
    }
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** Most-recently-modified run directory that has a run.json. */
function discoverRunDir() {
  if (!existsSync(RUNS_ROOT)) return null;
  const candidates = readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(RUNS_ROOT, entry.name))
    .filter((dir) => existsSync(join(dir, 'run.json')))
    .map((dir) => ({ dir, at: statSync(join(dir, 'run.json')).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return candidates[0]?.dir ?? null;
}

function resolveRunDir(flags) {
  const explicit = flags.run ?? process.env.AGENT_RUN_DIR ?? process.env.AGENT_SEASON_RUN;
  if (explicit) {
    const dir = resolve(REPO_ROOT, explicit);
    if (!existsSync(join(dir, 'run.json'))) fail(`No run.json at ${dir} — is "${explicit}" a run directory?`);
    return dir;
  }
  const discovered = discoverRunDir();
  if (!discovered) fail(`No runs found under ${RUNS_ROOT}. Pass --run <dir> or set AGENT_RUN_DIR.`);
  return discovered;
}

function resolveManagerId(flags, runDir) {
  const explicit = flags.manager ?? process.env.AGENT_MANAGER_ID ?? process.env.AGENT_ID;
  if (explicit) return String(explicit);
  const agentsDir = join(runDir, 'agents');
  if (existsSync(agentsDir)) {
    const agents = readdirSync(agentsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    if (agents.length === 1) return agents[0];
  }
  fail(`Cannot infer the manager id. Pass --manager <id> or set AGENT_MANAGER_ID.`);
}

function weekDirName(weekIndex) {
  return `week-${String(weekIndex).padStart(3, '0')}`;
}

/** The immutable run header, already validated by resolveRunDir. */
function readRun(runDir) {
  return readJson(join(runDir, 'run.json'));
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || !['ready', 'status', 'write'].includes(command)) {
    fail('Usage: node apps/api/scripts/agentWeek.mjs <ready|status|write> [--run <dir>] [--manager <id>] [--file <draft.json>]');
  }

  const runDir = resolveRunDir(flags);
  const managerId = resolveManagerId(flags, runDir);
  const run = readRun(runDir);
  const report = readJson(join(runDir, 'report.json'));
  const current = readJson(join(runDir, 'CURRENT.json'));
  const weekIndex = current?.weekIndex ?? 0;
  const weekDir = join(runDir, 'weeks', weekDirName(weekIndex));
  const digestFile = join(weekDir, `digest.${managerId}.json`);
  const decisionFile = join(weekDir, 'decisions', `${managerId}.json`);
  const agentDir = join(runDir, 'agents', managerId);
  const state = readJson(join(weekDir, 'state.json'));
  const complete = report?.meta?.complete === true || current?.phase === 'complete';

  if (command === 'ready') {
    writeJsonAtomic(join(agentDir, '.ready'), { managerId, at: new Date().toISOString(), pid: process.pid });
    console.log(JSON.stringify({ ok: true, command: 'ready', runId: run.runId, managerId, readyFile: join(agentDir, '.ready') }));
    process.exit(complete ? EXIT_ADVANCING : 0);
  }

  const phase = complete ? 'complete' : current?.phase ?? 'unknown';
  const accepted = state?.accepted?.[managerId] ?? null;
  const decisionExists = existsSync(decisionFile);
  const digestExists = existsSync(digestFile);
  const nackLog = readJson(join(weekDir, 'NACK.json'));
  const managerNacks = (nackLog?.attempts ?? []).filter((a) => a.managerId === managerId);
  const lastNack = managerNacks.length > 0 ? managerNacks[managerNacks.length - 1] : null;

  if (command === 'status') {
    const collecting = phase === 'open' || phase === 'collect';
    const decisionRequired = collecting && digestExists && !accepted && !decisionExists;
    const payload = {
      runId: run.runId,
      managerId,
      weekIndex,
      worldWeek: state?.worldWeek ?? current?.week ?? null,
      phase,
      complete,
      decisionRequired,
      alreadyWritten: Boolean(accepted) || decisionExists,
      accepted: Boolean(accepted),
      nacked: lastNack !== null,
      lastNack,
      digestFile: digestExists ? digestFile : null,
      decisionFile,
      draftFile: join(agentDir, 'decision.draft.json'),
      deadlineAt: state?.collectDeadlineAt ?? current?.deadlineAt ?? null,
      runDir,
      agentDir,
    };
    console.log(JSON.stringify(payload, null, 2));
    if (complete || !collecting) process.exit(EXIT_ADVANCING);
    if (decisionRequired) process.exit(EXIT_DECIDE);
    if (payload.alreadyWritten) process.exit(EXIT_ALREADY);
    // Collecting, but the runner has not finished writing this week's
    // digest yet — not "decided", so tell the agent to wait.
    process.exit(EXIT_ADVANCING);
  }

  // write
  if (complete || (phase !== 'open' && phase !== 'collect')) {
    console.log(
      JSON.stringify(
        { ok: false, reason: 'the decision window for this week has closed', phase, weekIndex, managerId },
        null,
        2,
      ),
    );
    process.exit(3);
  }
  const draftFile = resolve(REPO_ROOT, String(flags.file ?? process.env.AGENT_DECISION_FILE ?? join(agentDir, 'decision.draft.json')));
  if (!existsSync(draftFile)) fail(`Draft file not found: ${draftFile}`);
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftFile, 'utf8'));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, errors: [{ path: '$', message: `invalid JSON: ${error.message}` }] }, null, 2));
    console.error(`  - $: invalid JSON: ${error.message}`);
    process.exit(2);
  }

  const open = readJson(join(weekDir, 'OPEN.json'));
  const ctx = {
    runId: run.runId,
    weekIndex,
    managerId,
    currentWeek: open?.clock?.currentWeek ?? state?.worldWeek ?? null,
  };
  const { ok, errors } = validateDecision(draft, ctx);
  if (!ok) {
    console.log(JSON.stringify({ ok: false, draftFile, errors }, null, 2));
    console.error(`Decision rejected (${errors.length} schema error(s)):\n${formatValidationErrors(errors)}`);
    process.exit(2);
  }
  const replaced = decisionExists;
  writeJsonAtomic(decisionFile, draft);
  console.log(
    JSON.stringify(
      { ok: true, managerId, weekIndex, actions: draft.actions.length, summary: draft.summary, decisionFile, replaced },
      null,
      2,
    ),
  );
  process.exit(0);
}

main();
