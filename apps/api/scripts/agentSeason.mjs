#!/usr/bin/env node
/**
 * Agent-played-season harness — the deterministic RUNNER.
 *
 * Four (configurable) LLM agents, one per manager, each submit at most one
 * decision file per game-week. The runner is the only process that talks
 * to the game: agents never call the API, they read a per-manager digest
 * and write a decision, and the runner performs the HTTP actions on their
 * behalf. The world advances one game-WEEK at a time, and only after all
 * four have decided (or a stall deadline passed).
 *
 * Week state machine (each phase is persisted; the runner resumes from
 * the file system + the world clock after a crash/kill):
 *
 *   open    — build `digest.<managerId>.json` for every manager from the
 *             REAL endpoints, then wait for `agents/<id>/.ready` or the
 *             ready-gate timeout.
 *   collect — poll for `decisions/<id>.json`; validate with the shared
 *             schema; invalid files are moved to `decisions.invalid/` and
 *             recorded in `NACK.json` (the agent can resubmit); nudge at
 *             the nudge time; at the deadline record a miss and advance.
 *   apply   — apply every manager's accepted actions. Managers apply
 *             CONCURRENTLY (so a real race for a free agent is preserved
 *             and exactly one claim can win); within one manager actions
 *             apply SEQUENTIALLY in the fixed order
 *             release → claim → dissolvePair → createPair → acceptPair →
 *             entries (file order) → setTrainingFocus. `practice` actions
 *             are deferred to their listed game days in `advance`.
 *   advance — for day 1..7: run that day's due practice calls, then spawn
 *             the real day-tick pipeline (`soakTick.js --ticks 1 --start
 *             <index>`), assert the world clock moved exactly one day, and
 *             checkpoint `day-<d>.tick.json`. The tick index is DERIVED
 *             FROM THE WORLD CLOCK every day, never a stored counter:
 *             `GameWorld.advanceDay` only refuses the EXACT last tick key,
 *             so a stale counter could silently over-advance, while a
 *             clock-derived key is idempotent by construction (a retry of
 *             an already-applied day recomputes a key the world has moved
 *             past; a not-yet-applied day recomputes the same key and is
 *             accepted).
 *   close   — snapshot pre-prune health, run the SAME prune/archive SQL
 *             soak.mjs uses, write `week-NNN.ADVANCED.json`, append
 *             `decisions.jsonl`, update `report.json`.
 *
 * Resume: position = newest `ADVANCED.json` + the world clock. An
 * in-flight week skips actions already `ok:true` in `apply/*.jsonl` and
 * days already checkpointed, so a day is NEVER ticked twice. A tick child
 * that fails (or a clock that does not advance exactly one day) writes a
 * checkpoint flagged `partialTickSuspected` (when the clock moved anyway),
 * captures the child's `WORLD_TICK_PROFILE` phases, and STOPS the run
 * rather than continuing.
 *
 * Safety:
 *   - refuses to run unless the DB name matches /agent/i (or `--allow-db`);
 *   - takes a LOCK.json + heartbeat; a live lock on this host blocks a
 *     second runner (a dead pid or a stale heartbeat is taken over);
 *   - at boot reads `/world/clock` twice ~10s apart and aborts if
 *     `lastTickAt` moved (another tick driver is live);
 *   - NEVER starts the real worker; day ticks are only ever driven by the
 *     spawned `soakTick.js` child.
 *
 * Usage (see RULES.md templates generated into runs/<runId>/protocol/):
 *   node apps/api/scripts/agentSeason.mjs \
 *     --run-id agents-season-1 --weeks 52 \
 *     --api http://localhost:3200 \
 *     --db postgresql://tennis:tennis@localhost:5432/tennis_manager_agents \
 *     --world agents --managers agent-m1,agent-m2,agent-m3,agent-m4
 */
import pg from 'pg';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  absoWeek,
  archiveOldMatchRows,
  cohortDeltas,
  collectFinalEvidence,
  collectStrategyOutcomes,
  normalizeBootstrap,
  pruneStuckTournaments,
  q,
  snapshotEconomy,
  snapshotTracked,
  weeklyHealth,
} from './lib/soakEvidence.mjs';
import { formatValidationErrors, validateDecision } from './lib/decisionSchema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SOAK_TICK_PATH = join(REPO_ROOT, 'apps', 'worker', 'dist', 'scripts', 'soakTick.js');

const DAYS_PER_WEEK = 7;
const WEEKS_PER_SEASON = 52;
const ACTION_ORDER = [
  'release',
  'claim',
  'dissolvePair',
  'createPair',
  'acceptPair',
  'enterSingles',
  'enterDoubles',
  'setTrainingFocus',
];
const FORBIDDEN_DIGEST_KEYS = ['experience', 'talent', 'potentialCeiling', 'physicalCeilings'];
const TIER_PRESTIGE = {
  futures: 1,
  challenger: 2,
  tour: 3,
  major: 4,
  j30: 1,
  j60: 2,
  j100: 3,
  j200: 4,
  j300: 5,
  j500: 6,
  juniorMasters: 7,
};

const DEFAULTS = {
  runId: null,
  runRoot: 'runs',
  api: 'http://localhost:3200',
  db: process.env.AGENT_SEASON_DB ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager_agents',
  world: 'agents',
  weeks: 52,
  managers: 'agent-m1,agent-m2,agent-m3,agent-m4',
  fundXp: 100_000,
  ratePerSec: 4.5,
  readyGateMs: 10 * 60 * 1000,
  collectMs: 15 * 60 * 1000,
  nudgeMs: 5 * 60 * 1000,
  pollMs: 2000,
  staleLockMs: 2 * 60 * 1000,
  allowDb: false,
  forceLock: false,
  skipHeartbeatCheck: false,
  stopAfterDay: null,
  prune: true,
  archive: true,
  evidence: true,
};

class StopRunError extends Error {
  constructor(message, exitCode = 3) {
    super(message);
    this.exitCode = exitCode;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const todayStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function parseArgs(argv) {
  const raw = {};
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
  const num = (v, fallback) => (v === undefined || v === 'true' ? fallback : Number(v));
  const bool = (v, fallback) => (v === undefined ? fallback : v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : fallback);
  return {
    runId: typeof raw['run-id'] === 'string' ? raw['run-id'] : DEFAULTS.runId,
    runRoot: typeof raw['run-root'] === 'string' ? raw['run-root'] : DEFAULTS.runRoot,
    api: typeof raw.api === 'string' ? raw.api : DEFAULTS.api,
    db: typeof raw.db === 'string' ? raw.db : DEFAULTS.db,
    world: typeof raw.world === 'string' ? raw.world : DEFAULTS.world,
    weeks: num(raw.weeks, DEFAULTS.weeks),
    managers: (typeof raw.managers === 'string' ? raw.managers : DEFAULTS.managers).split(',').map((s) => s.trim()).filter(Boolean),
    fundXp: num(raw['fund-xp'], DEFAULTS.fundXp),
    ratePerSec: num(raw.rate, DEFAULTS.ratePerSec),
    readyGateMs: num(raw['ready-gate-ms'], DEFAULTS.readyGateMs),
    collectMs: num(raw['collect-ms'], DEFAULTS.collectMs),
    nudgeMs: num(raw['nudge-ms'], DEFAULTS.nudgeMs),
    pollMs: num(raw['poll-ms'], DEFAULTS.pollMs),
    staleLockMs: num(raw['stale-lock-ms'], DEFAULTS.staleLockMs),
    allowDb: bool(raw['allow-db'], DEFAULTS.allowDb),
    forceLock: bool(raw['force-lock'], DEFAULTS.forceLock),
    skipHeartbeatCheck: bool(raw['skip-heartbeat-check'], DEFAULTS.skipHeartbeatCheck),
    stopAfterDay: raw['stop-after-day'] !== undefined && raw['stop-after-day'] !== 'true' ? Number(raw['stop-after-day']) : null,
    prune: bool(raw.prune, DEFAULTS.prune),
    archive: bool(raw.archive, DEFAULTS.archive),
    evidence: bool(raw.evidence, DEFAULTS.evidence),
  };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, value) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonl(file, value) {
  ensureDir(dirname(file));
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function weekDirName(weekIndex) {
  return `week-${String(weekIndex).padStart(3, '0')}`;
}

function absoDay(clock) {
  // Absolute day index derived ONLY from the world clock — see the module
  // doc comment. +1 per real day across week and season boundaries.
  return (clock.currentWeek.season - 1) * WEEKS_PER_SEASON * DAYS_PER_WEEK + (clock.currentWeek.week - 1) * DAYS_PER_WEEK + (clock.currentDay - 1);
}

function addWeeks(week, n) {
  // absoWeek is `season * 52 + week` (see lib/soakEvidence.mjs), whose
  // inverse is exactly this — S1W1 = 53, S1W52 = 104, S2W1 = 105.
  const abs = absoWeek(week) + n;
  return { season: Math.floor((abs - 1) / WEEKS_PER_SEASON), week: ((abs - 1) % WEEKS_PER_SEASON) + 1 };
}

function maskDb(url) {
  return String(url).replace(/:[^:@/]+@/, ':***@');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Logging / HTTP
// ---------------------------------------------------------------------------

let runnerLogPath = null;
let verbose = true;

function log(message, extra = {}) {
  const line = { at: nowIso(), msg: message, ...extra };
  if (runnerLogPath) appendFileSync(runnerLogPath, `${JSON.stringify(line)}\n`);
  const extras = Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  if (verbose) console.log(`[agent-season] ${message}${extras ? ` — ${extras}` : ''}`);
}

let nextSlot = 0;
let ratePerSec = DEFAULTS.ratePerSec;

function acquireSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 1000 / ratePerSec;
  return sleep(slot - now);
}

const http = {
  total: 0,
  byRoute: {},
  serverErrors: [],
  unexpected4xx: [],
  ruleRejections: {},
  concurrencyConflicts: 0,
};

const ROUTE_PATTERNS = [
  [/^\/talent-pool\/[^/]+\/claim$/, '/talent-pool/:id/claim'],
  [/^\/tournaments\/[^/]+\/entrants$/, '/tournaments/:id/entrants'],
  [/^\/tournaments\/[^/]+\/doubles-entrants$/, '/tournaments/:id/doubles-entrants'],
  [/^\/players\/[^/]+\/training-focus$/, '/players/:id/training-focus'],
  [/^\/players\/[^/]+\/practice$/, '/players/:id/practice'],
  [/^\/players\/[^/]+\/release$/, '/players/:id/release'],
  [/^\/players\/[^/]+\/profile$/, '/players/:id/profile'],
  [/^\/players\/[^/]+\/current-matches$/, '/players/:id/current-matches'],
  [/^\/players\/[^/]+\/entry-planner$/, '/players/:id/entry-planner'],
  [/^\/managers\/[^/]+\/entitlement$/, '/managers/:id/entitlement'],
  [/^\/managers\/[^/]+\/roster-dashboard$/, '/managers/:id/roster-dashboard'],
  [/^\/managers\/[^/]+\/players$/, '/managers/:id/players'],
  [/^\/managers\/[^/]+\/doubles-pairs$/, '/managers/:id/doubles-pairs'],
  [/^\/doubles-pairs\/[^/]+\/(accept|dissolve)$/, '/doubles-pairs/:id/$1'],
  [/^\/tournaments\/[^/]+$/, '/tournaments/:id'],
];

function routeKey(method, path) {
  const clean = path.split('?')[0];
  for (const [re, replacement] of ROUTE_PATTERNS) {
    if (re.test(clean)) return `${method} ${clean.replace(re, replacement)}`;
  }
  return `${method} ${clean}`;
}

const EXPECTED_RULE_SUBSTRINGS = [
  'insufficient xp', 'roster is full', 'at capacity', 'already', 'age', 'cap',
  'must not have an ageband', 'does not support', 'not eligible', 'not found in your roster',
  'not found', 'week', 'registered', 'too old', 'entry', 'slot', 'claim', 'pair',
  'qualifying field is already full', 'outside direct acceptance', 'retired', 'cannot enter',
  'not on manager', 'no longer available', 'reached the weekly limit', 'has already entered',
  'free agent', 'is not on', 'unavailable',
];

function recordHttp(key, status, method, path, body, managerId) {
  http.total += 1;
  const bucket = (http.byRoute[key] ??= {});
  bucket[status] = (bucket[status] ?? 0) + 1;
  if (status >= 500 || status === 0) {
    http.serverErrors.push({ method, path, status, body, managerId });
    return;
  }
  if (status >= 400) {
    const message = String(body?.error ?? '');
    if (message.toLowerCase().includes('modified by another request')) {
      http.concurrencyConflicts += 1;
      return;
    }
    const expected = message === '' || EXPECTED_RULE_SUBSTRINGS.some((s) => message.toLowerCase().includes(s));
    if (expected) {
      const k = message || `${status} (no message)`;
      http.ruleRejections[k] = (http.ruleRejections[k] ?? 0) + 1;
    } else {
      http.unexpected4xx.push({ method, path, status, body, managerId });
    }
  }
}

let apiBase = DEFAULTS.api;

/** HTTP with the shared token bucket, retries, and a route x status ledger. */
async function api(method, path, body, managerId) {
  const key = routeKey(method, path);
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (managerId) headers['x-dev-manager-id'] = managerId;

  for (let attempt = 0; attempt < 5; attempt++) {
    await acquireSlot();
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* non-JSON */
      }
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      recordHttp(key, res.status, method, path, json, managerId);
      return { status: res.status, ok: res.ok, body: json };
    } catch {
      await sleep(800);
    }
  }
  recordHttp(key, 0, method, path, { error: 'network failure after retries' }, managerId);
  return { status: 0, ok: false, body: { error: 'network failure after retries' } };
}

async function getClock() {
  const res = await api('GET', '/world/clock');
  if (!res.ok || !res.body?.currentWeek) {
    throw new StopRunError(`GET /world/clock failed (status ${res.status}) — is the API running at ${apiBase} with WORLD_ID=${runCtx?.world ?? '?'}?`);
  }
  return res.body;
}

// ---------------------------------------------------------------------------
// Run directory + lock + protocol templates
// ---------------------------------------------------------------------------

function protocolTemplates(run) {
  const runDir = run.runDir;
  const cmds = (managerId) => `node apps/api/scripts/agentWeek.mjs`;
  const exampleManager = run.managers[0];

  const rules = `# Agent season — RULES (read once, then act)

Run: \`${run.runId}\` · ${run.managers.length} managers · ${run.weeksPlanned} game-weeks · world \`${run.world}\`.
Run directory: \`${runDir}\`.

## The one rule that matters
You never touch the game API. The RUNNER performs every action over HTTP on
your behalf. You read your digest and write one decision file per week.

## Commands (run from the repo root)
- \`${cmds()} ready --run ${runDir} --manager <yourId>\` — once at boot.
- \`${cmds()} status --run ${runDir} --manager <yourId>\` — poll. Exit 0 = decide
  now; exit 10 = already submitted; exit 11 = world advancing / run complete.
- \`${cmds()} write --run ${runDir} --manager <yourId> --file <draft>\` — validate
  and submit. Exit 0 accepted; exit 2 schema errors (fix and retry).

## Decision file (schemaVersion 1)
\`\`\`json
{
  "schemaVersion": 1,
  "runId": "${run.runId}",
  "weekIndex": <the weekIndex from status>,
  "managerId": "<yourId>",
  "summary": "one paragraph: what you are doing this week and why",
  "actions": [ /* up to 40; may be empty */
    { "type": "claim", "playerId": "..." },
    { "type": "setTrainingFocus", "playerId": "...", "attribute": "serve" },
    { "type": "enterSingles", "playerId": "...", "tournamentId": "..." },
    { "type": "practice", "playerId": "...", "days": [2, 5] }
  ]
}
\`\`\`

## Action list (exactly these shapes; unknown fields are rejected)
| Type | Fields | HTTP the RUNNER issues for you |
|---|---|---|
| release | playerId | POST /players/:playerId/release |
| claim | playerId | POST /talent-pool/:playerId/claim {managerId} |
| dissolvePair | pairId | POST /doubles-pairs/:pairId/dissolve |
| createPair | playerA, playerB | POST /doubles-pairs {playerA, playerB} |
| acceptPair | pairId | POST /doubles-pairs/:pairId/accept |
| enterSingles | playerId, tournamentId | POST /tournaments/:tournamentId/entrants {playerId} |
| enterDoubles | playerId, tournamentId | POST /tournaments/:tournamentId/doubles-entrants {playerId} |
| setTrainingFocus | playerId, attribute, effectiveFrom? | PUT /players/:playerId/training-focus |
| practice | playerId, days[1..7] | POST /players/:playerId/practice on each listed day |

- Trainable attributes: serve, forehand, backhand, volley, speed, stamina,
  strength, doubles. Mental attributes (consistency, clutch) are NEVER trainable.
- \`effectiveFrom\` is optional \`{season, week}\`; it must be the current or a
  future week. Omit it to start now.
- \`practice\` days are game days 1..7 of THIS week; practice runs before that
  day's tick. Each player can practice at most once per game day.
- A free agent you CLAIM this week joins your roster, but this week's digest
  was built before the claim, so the new player has no entry candidates in it
  yet — enter them from NEXT week's digest (the \`events.canEnterNow\` map is
  keyed by player id).
- \`lastApply\` in the digest lists last week's action outcomes, including the
  server's rejection reason for anything that failed; \`missedWeeks\` lists the
  weeks you did not submit. Read both before repeating a rejected action.

## Apply order (per manager, sequential)
release → claim → dissolvePair → createPair → acceptPair → enterSingles /
enterDoubles in the order you list them → setTrainingFocus. Practice actions
are deferred to their listed days. Different managers apply CONCURRENTLY, so
two claims for the same free agent are a real race: exactly one wins.

## Limits and failures
- At most 40 actions per week. Empty actions are a valid week (you sat out).
- Invalid decision (wrong runId/weekIndex/managerId, unknown action/field,
  bad attribute, past effectiveFrom, duplicate practice day, >40 actions):
  the runner NACKs the file, records why in \`NACK.json\`, and keeps waiting
  until the deadline — you may fix it and resubmit before the deadline.
- Missed deadline = the week is recorded as a miss; the world still advances.
- The digest NEVER contains hidden values (\`experience\`, \`talent\`,
  \`potentialCeiling\`, \`physicalCeilings\`). Judge the visible attributes,
  current OVR, age, form, fatigue and the scout's projection only.

## What a good week looks like
Enter eligible tournaments (nearest week first), keep fatigue low and form in
its sweet spot, keep a standing training focus, use practice days on quiet
weeks, claim a free agent only when a roster slot and XP allow it, and set up
doubles pairs deliberately (a pair needs both players focused on doubles).
`;

  const boot = `# Agent season — BOOT PROMPT

You are an autonomous tennis manager in run \`${run.runId}\`.

- You are ONE of ${run.managers.length} managers: ${run.managers.join(', ')}.
- Your manager id: <YOUR_ID> (given to you by the orchestrator).
- Run directory: \`${runDir}\`.
- The world advances one game-week at a time and only after all managers have
  submitted a decision (or the deadline passes). You will play ${run.weeksPlanned}
  weeks. Every week matters: missed weeks are lost opportunities.

## Do not use the game API
The runner performs every action over HTTP for you. Do not fetch game URLs and
do not call any other endpoint. Your entire interface is the \`agentWeek.mjs\`
CLI and the digest file it points you at.

## Boot (do this once)
1. Read \`${runDir}/protocol/RULES.md\` in full.
2. Run:
   \`node apps/api/scripts/agentWeek.mjs ready --run ${runDir} --manager <YOUR_ID>\`
3. Then start the weekly loop (see WEEK_PROMPT.md).

## Weekly loop (repeat until the run is complete)
1. \`status\` (exit 0 = decide, 10 = already submitted, 11 = advancing/complete).
2. On exit 0: read the digest file the status JSON names. Decide your actions.
3. Write your draft to \`${runDir}/agents/<YOUR_ID>/decision.draft.json\` and submit:
   \`node apps/api/scripts/agentWeek.mjs write --run ${runDir} --manager <YOUR_ID>\`
4. Check it exited 0. If it exited 2, read the schema errors, fix, resubmit.
5. Poll \`status\` every ~30s; exit 10 means this week is done.

## Standing objectives (${run.weeksPlanned} weeks)
- Build a roster within your cap (free tier: 2 players; Pro: 4) using the
  talent pool — claim cost scales with age/ability, so a young prospect is
  cheap XP and grows.
- Enter your players in tournaments they can win (check entryViaQualifying,
  qualifyingFieldFull, rankRestricted, weekly entry cap in the digest).
- Keep training focuses current; use \`practice\` on days you are not deep in
  a tournament. Form has a sweet spot (digest shows form/fatigue).
- Doubles pairs gain chemistry over matches; enter pairs together.
- Manage fatigue: it accrues per match and recovers a little each game day.

Record your reasoning in the \`summary\` field every week — it is your log.
`;

  const week = `# Agent season — WEEK PROMPT

Run this exact command first:
\`node apps/api/scripts/agentWeek.mjs status --run ${runDir} --manager <YOUR_ID>\`

- Exit 11: the world is advancing or the season is complete. Wait ~60s and run
  it again. Do not read any file until it exits 0.
- Exit 10: you already submitted this week. Wait ~60s and run it again.
- Exit 0: decide now. (It also covers the case where your previous file was
  NACKed — check the \`lastNack\` field in the status JSON for the reason, fix
  the draft, and submit again.)

## When status exits 0
1. Read the \`digestFile\` named in the status JSON. It is the ONLY game state
   you get, and it was built from the live world moments ago. It contains your
   roster (attributes, fatigue, form, rank/peaks/titles/prize, potential
   projection, last 3 results, next match, pending entries), the signable
   talent pool (claim cost included), your pairs, last week's apply outcomes,
   and this week's event candidates (\`events.canEnterNow\` per player, plus
   \`events.openByWeek\` for scouting further ahead).
2. Choose up to 40 actions (schema and action list in RULES.md). Prefer
   concrete moves: enter eligible events in the nearest week, set training
   focus, spend practice days, claim/enter/release to fit the roster cap.
3. Write your draft as JSON to:
   \`${runDir}/agents/<YOUR_ID>/decision.draft.json\`
4. Submit it:
   \`node apps/api/scripts/agentWeek.mjs write --run ${runDir} --manager <YOUR_ID> --file ${runDir}/agents/<YOUR_ID>/decision.draft.json\`
5. Exit 0 = accepted (you will see the decisionFile path). Exit 2 = schema
   errors: read them, fix the draft, resubmit. Exit 3 = the window closed;
   stop and go back to polling \`status\`.

Never invent player/tournament ids: only use ids from the digest.
`;

  const exampleDraft = {
    schemaVersion: 1,
    runId: run.runId,
    weekIndex: 0,
    managerId: exampleManager,
    summary: 'Example: claim the cheapest healthy prospect, train serve, enter the nearest futures event.',
    actions: [
      { type: 'claim', playerId: '<id from digest.talentPool>' },
      { type: 'setTrainingFocus', playerId: '<your playerId>', attribute: 'serve' },
      { type: 'practice', playerId: '<your playerId>', days: [3, 6] },
      { type: 'enterSingles', playerId: '<your playerId>', tournamentId: '<id from digest.events.canEnterNow>' },
    ],
  };

  return { rules, boot, week, exampleDraft };
}

// ---------------------------------------------------------------------------
// Digest builder
// ---------------------------------------------------------------------------

function assertNoHiddenFields(value, path = 'digest') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoHiddenFields(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_DIGEST_KEYS.includes(key)) {
        throw new Error(`digest leaks a hidden field ("${key}") at ${path}.${key} — value-hiding discipline violated`);
      }
      assertNoHiddenFields(child, `${path}.${key}`);
    }
  }
}

function compactAttributes(attributes) {
  return {
    technical: { ...attributes.technical },
    physical: { ...attributes.physical },
    mental: { ...attributes.mental },
    doubles: attributes.doubles,
    surfaceAffinities: { ...attributes.surfaceAffinities },
  };
}

function overallOf(attributes) {
  const values = [
    attributes.technical.serve,
    attributes.technical.forehand,
    attributes.technical.backhand,
    attributes.technical.volley,
    attributes.physical.speed,
    attributes.physical.stamina,
    attributes.physical.strength,
    attributes.mental.consistency,
    attributes.mental.clutch,
  ].map((v) => (typeof v === 'object' && v !== null ? v.value : v));
  return Math.round(values.reduce((sum, v) => sum + Number(v), 0) / values.length);
}

function compactTournamentBase(t) {
  const totalRounds = Math.round(Math.log2(t.drawSize));
  return {
    id: t.id,
    name: t.name,
    tier: t.tier,
    circuit: t.circuit,
    ageBand: t.ageBand,
    surface: t.surface,
    hostCountry: t.hostCountry,
    weekScheduled: t.weekScheduled,
    drawSize: t.drawSize,
    totalRounds,
    mainDrawEntrants: t.mainDrawEntrants,
    doublesDrawSize: t.doublesDrawSize,
    doublesEntrants: Array.isArray(t.doublesEntrants) ? t.doublesEntrants.length : 0,
    obligatory: t.obligatory === true,
    managerEntrants: typeof t.managerEntrants === 'number' ? t.managerEntrants : null,
    championPoints: Array.isArray(t.pointsBreakdown) ? t.pointsBreakdown[0]?.points ?? null : null,
    championPrizeMoney: Array.isArray(t.prizeMoneyBreakdown) ? t.prizeMoneyBreakdown[0]?.prizeMoney ?? null : null,
  };
}

function compactCandidate(t) {
  return {
    ...compactTournamentBase(t),
    entryViaQualifying: t.entryViaQualifying === true,
    qualifyingFieldFull: t.qualifyingFieldFull === true,
    qualifyingFieldSize: t.qualifyingFieldSize ?? 0,
    qualifyingFieldTaken: t.qualifyingFieldTaken ?? 0,
    rankRestricted: t.rankRestricted === true,
    rankRestrictedReason: t.rankRestrictedReason ?? null,
    weeklyEntryCountThisWeek: t.weeklyEntryCountThisWeek ?? null,
    weeklyEntryCapThisWeek: t.weeklyEntryCapThisWeek ?? null,
  };
}

function isEnterableCandidate(t, currentAbs) {
  if (t.hasStarted || t.registrationOpen === false) return false;
  if (t.ageEligible === false) return false;
  if (t.rankRestricted === true) return false;
  if (
    typeof t.weeklyEntryCountThisWeek === 'number' &&
    typeof t.weeklyEntryCapThisWeek === 'number' &&
    t.weeklyEntryCountThisWeek >= t.weeklyEntryCapThisWeek
  ) {
    return false;
  }
  const mainRoom = (t.mainDrawEntrants ?? 0) < t.drawSize;
  const qualifyingRoom = t.entryViaQualifying === true && t.qualifyingFieldFull !== true;
  if (!mainRoom && !qualifyingRoom) return false;
  return absoWeek(t.weekScheduled) >= currentAbs;
}

function compareCandidates(a, b) {
  const weekDiff = absoWeek(a.weekScheduled) - absoWeek(b.weekScheduled);
  if (weekDiff !== 0) return weekDiff;
  const tierDiff = (TIER_PRESTIGE[b.tier] ?? 0) - (TIER_PRESTIGE[a.tier] ?? 0);
  if (tierDiff !== 0) return tierDiff;
  return String(a.name).localeCompare(String(b.name));
}

const MAX_TALENT_POOL = 24;
const MAX_CAN_ENTER_NOW = 10;
const MAX_OPEN_WEEKS = 13;
const MAX_EVENTS_PER_WEEK = 6;

/**
 * Builds one manager's weekly digest from the REAL endpoints. The digest is
 * subject to the same value-hiding discipline as any DTO: it can never
 * contain `experience`, `talent`, `potentialCeiling` or `physicalCeilings`
 * (`assertNoHiddenFields` throws rather than letting one through).
 */
async function buildDigest({ run, weekIndex, worldWeek, clock, deadlineAt, report, managerId }) {
  const entitlementRes = await api('GET', '/me/entitlement', undefined, managerId);
  if (!entitlementRes.ok) throw new StopRunError(`entitlement fetch failed for ${managerId} (status ${entitlementRes.status})`);
  const rosterRes = await api('GET', '/me/players', undefined, managerId);
  if (!rosterRes.ok) throw new StopRunError(`roster fetch failed for ${managerId} (status ${rosterRes.status})`);
  const dashboardRes = await api('GET', '/me/roster-dashboard', undefined, managerId);
  const pairsRes = await api('GET', '/me/doubles-pairs', undefined, managerId);
  const ladderRes = await api('GET', '/managers/leaderboard?limit=1', undefined, managerId);

  const players = Array.isArray(rosterRes.body) ? rosterRes.body : [];
  const dashboard = Array.isArray(dashboardRes.body) ? dashboardRes.body : [];
  const dashboardById = new Map(dashboard.map((entry) => [entry.id, entry]));
  const entitlement = entitlementRes.body ?? {};
  const tier = entitlement.tier === 'pro' ? 'pro' : 'free';
  const rosterCap = tier === 'pro' ? 4 : 2;
  const activeCount = players.filter((p) => p.stage !== 'retired').length;

  const roster = [];
  const canEnterNow = {};
  const openTournamentUnion = new Map();
  const trackedPlayerIds = [];
  const currentAbs = absoWeek(clock.currentWeek);

  for (const player of players) {
    trackedPlayerIds.push(player.id);
    const dash = dashboardById.get(player.id) ?? null;
    const [profileRes, matchesRes, plannerRes, openRes] = await Promise.all([
      api('GET', `/players/${encodeURIComponent(player.id)}/profile`),
      api('GET', `/players/${encodeURIComponent(player.id)}/current-matches`),
      api('GET', `/players/${encodeURIComponent(player.id)}/entry-planner?weeks=${MAX_OPEN_WEEKS}`),
      api('GET', `/tournaments?status=open&playerId=${encodeURIComponent(player.id)}`),
    ]);
    const profile = profileRes.ok ? profileRes.body : null;
    const matches = matchesRes.ok ? matchesRes.body : null;
    const planner = Array.isArray(plannerRes.body) ? plannerRes.body : [];
    const openList = Array.isArray(openRes.body) ? openRes.body : [];

    for (const t of openList) {
      if (!openTournamentUnion.has(t.id)) openTournamentUnion.set(t.id, t);
    }

    const pendingEntries = [];
    for (const week of planner) {
      for (const entry of week.entries ?? []) {
        if (entry.hasStarted) continue;
        pendingEntries.push({
          week: entry.weekScheduled,
          tournamentId: entry.id,
          name: entry.name,
          tier: entry.tier,
          ageBand: entry.ageBand,
          surface: entry.surface,
        });
        if (pendingEntries.length >= 13) break;
      }
      if (pendingEntries.length >= 13) break;
    }

    const candidates = openList
      .filter((t) => isEnterableCandidate(t, currentAbs))
      .sort(compareCandidates)
      .slice(0, MAX_CAN_ENTER_NOW)
      .map(compactCandidate);
    canEnterNow[player.id] = candidates;

    const rankings = profile?.currentRankings ?? [];
    const band = dash?.rankBand ?? profile?.currentEligibleBand ?? 'senior';
    const ownRank = rankings.find((r) => r.band === band) ?? { band, totalPoints: 0, rank: null };

    roster.push({
      identity: {
        playerId: player.id,
        name: player.name,
        nationality: player.nationality,
        ageInWeeks: player.ageInWeeks,
        stage: player.stage,
        fillOnly: player.fillOnly === true,
      },
      attributes: compactAttributes(player.attributes),
      overall: dash?.overall ?? overallOf(player.attributes),
      fatigue: player.fatigue,
      form: player.form,
      stageNote: dash?.stageNote ?? null,
      focus: dash?.trainingFocus ?? null,
      rankBand: band,
      rank: { band, rank: ownRank.rank, points: ownRank.totalPoints },
      allRankings: rankings,
      peaks: profile?.peakRankings ?? [],
      titles: (profile?.titles ?? []).map((t) => ({
        tournamentId: t.tournamentId,
        name: t.name,
        tier: t.tier,
        ageBand: t.ageBand,
        weekEarned: t.weekEarned,
      })),
      prizeMoney: {
        career: profile?.careerPrizeMoney ?? player.careerPrizeMoney ?? 0,
        season: profile?.seasonPrizeMoney ?? player.seasonPrizeMoney ?? 0,
      },
      potential: profile?.potential ?? null,
      lastResults: (matches?.recent ?? []).slice(0, 3).map((m) => ({
        tournamentId: m.tournamentId,
        tournamentName: m.tournamentName,
        tier: m.tier,
        roundNumber: m.roundNumber,
        result: m.result,
        setScores: m.setScores,
        weekScheduled: m.weekScheduled,
      })),
      nextMatch: matches?.next
        ? {
            tournamentId: matches.next.tournamentId,
            tournamentName: matches.next.tournamentName,
            tier: matches.next.tier,
            roundNumber: matches.next.roundNumber,
            opponentName: matches.next.opponentName,
            scheduledStartAt: matches.next.scheduledStartAt,
            revealSeconds: matches.next.revealSeconds,
          }
        : null,
      pendingEntries,
      doublesPartner: profile?.doublesPartner
        ? {
            pairId: profile.doublesPartner.pairId,
            status: profile.doublesPartner.status,
            playerId: profile.doublesPartner.playerId,
            name: profile.doublesPartner.name,
            chemistry: profile.doublesPartner.chemistry,
          }
        : null,
    });
  }

  // The pool route is paginated (P1-A2): the digest asks for a large page
  // and maps its `candidates`. A legacy array body is still accepted.
  const poolRes = await api('GET', '/talent-pool?limit=256');
  const poolBody = Array.isArray(poolRes.body) ? poolRes.body : poolRes.body?.candidates;
  const freeAgents = (Array.isArray(poolBody) ? poolBody : [])
    .filter((a) => a.signingBlocked !== true)
    .map((a) => ({
      id: a.id,
      name: a.name,
      nationality: a.nationality,
      ageInWeeks: a.ageInWeeks,
      overall: overallOf(a.attributes),
      claimCost: a.claimCost,
      titleCount: a.titleCount ?? 0,
      careerPrizeMoney: a.careerPrizeMoney ?? 0,
      attributes: compactAttributes(a.attributes),
    }))
    .sort((a, b) => b.overall - a.overall || a.claimCost - b.claimCost)
    .slice(0, MAX_TALENT_POOL);

  const pairs = (Array.isArray(pairsRes.body) ? pairsRes.body : []).map((pair) => ({
    id: pair.id,
    status: pair.status,
    chemistry: pair.chemistry,
    playerA: { playerId: pair.playerA?.playerId, name: pair.playerA?.name },
    playerB: { playerId: pair.playerB?.playerId, name: pair.playerB?.name },
  }));

  // Event catalogue shared across managers: nearest <=13 weeks, <=6 events each.
  const byWeek = new Map();
  for (const t of openTournamentUnion.values()) {
    if (t.hasStarted) continue;
    const key = absoWeek(t.weekScheduled);
    const bucket = byWeek.get(key) ?? [];
    bucket.push(t);
    byWeek.set(key, bucket);
  }
  const openByWeek = [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_OPEN_WEEKS)
    .map(([, bucket]) => ({
      week: bucket[0].weekScheduled,
      events: bucket
        .sort(compareCandidates)
        .slice(0, MAX_EVENTS_PER_WEEK)
        .map(compactTournamentBase),
    }));

  // Last week's apply outcomes, so the agent learns what was rejected.
  const lastApply = weekIndex > 0 ? readJsonl(join(run.runDir, 'weeks', weekDirName(weekIndex - 1), 'apply', `${managerId}.jsonl`)) : [];
  const lastApplyCompact = lastApply
    .filter((entry) => entry.type !== 'practice')
    .slice(-50)
    .map((entry) => ({ type: entry.type, action: entry.action, ok: entry.ok, status: entry.status, error: entry.error ?? null }));

  const missedWeeks = (report.weeks ?? [])
    .filter((week) => week.decisions?.[managerId] === 'missed')
    .map((week) => week.weekIndex);

  const digest = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    runId: run.runId,
    weekIndex,
    managerId,
    clock: {
      season: clock.currentWeek.season,
      week: clock.currentWeek.week,
      day: clock.currentDay,
      daysPerWeek: clock.daysPerWeek ?? DAYS_PER_WEEK,
      currentWeek: clock.currentWeek,
      nextTickAt: clock.nextTickAt ?? null,
      nextWeekTickAt: clock.nextWeekTickAt ?? null,
      readyDeadlineAt: deadlineAt.readyDeadlineAt,
      decisionDeadlineAt: deadlineAt.decisionDeadlineAt,
    },
    manager: {
      managerId,
      tier,
      customPlayerCredits: entitlement.customPlayerCredits ?? 0,
      xpBalance: entitlement.xpBalance ?? 0,
      rosterCap,
      rosterCount: activeCount,
      ladder: ladderRes.ok ? ladderRes.body?.self ?? null : null,
    },
    roster,
    talentPool: freeAgents,
    pairs,
    events: { canEnterNow, openByWeek },
    lastApply: lastApplyCompact,
    missedWeeks,
  };
  assertNoHiddenFields(digest);
  return { digest, trackedPlayerIds };
}

// ---------------------------------------------------------------------------
// Decision collection / apply
// ---------------------------------------------------------------------------

function orderActions(actions) {
  return actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => {
      const ra = ACTION_ORDER.indexOf(a.action.type);
      const rb = ACTION_ORDER.indexOf(b.action.type);
      const oa = ra === -1 ? ACTION_ORDER.length : ra;
      const ob = rb === -1 ? ACTION_ORDER.length : rb;
      return oa - ob || a.index - b.index;
    });
}

async function actionHttp(action, managerId) {
  const pid = encodeURIComponent(action.playerId ?? '');
  switch (action.type) {
    case 'release':
      return api('POST', `/players/${pid}/release`, undefined, managerId);
    case 'claim':
      return api('POST', `/talent-pool/${pid}/claim`, { managerId }, managerId);
    case 'dissolvePair':
      return api('POST', `/doubles-pairs/${encodeURIComponent(action.pairId)}/dissolve`, undefined, managerId);
    case 'createPair':
      return api('POST', '/doubles-pairs', { playerA: action.playerA, playerB: action.playerB }, managerId);
    case 'acceptPair':
      return api('POST', `/doubles-pairs/${encodeURIComponent(action.pairId)}/accept`, undefined, managerId);
    case 'enterSingles':
      return api('POST', `/tournaments/${encodeURIComponent(action.tournamentId)}/entrants`, { playerId: action.playerId }, managerId);
    case 'enterDoubles':
      return api('POST', `/tournaments/${encodeURIComponent(action.tournamentId)}/doubles-entrants`, { playerId: action.playerId }, managerId);
    case 'setTrainingFocus':
      return api(
        'PUT',
        `/players/${pid}/training-focus`,
        { focus: { kind: 'attribute', attribute: action.attribute }, ...(action.effectiveFrom ? { week: action.effectiveFrom } : {}) },
        managerId,
      );
    case 'practice':
      return api('POST', `/players/${pid}/practice`, undefined, managerId);
    default:
      return { status: 0, ok: false, body: { error: `unknown action type "${action.type}"` } };
  }
}

/** One retry on the repository's retryable optimistic-concurrency 409. */
async function actionWithRetry(action, managerId) {
  let res = await actionHttp(action, managerId);
  if (res.status === 409 && String(res.body?.error ?? '').includes('modified by another request')) {
    await sleep(250);
    res = await actionHttp(action, managerId);
  }
  return res;
}

async function applyManager({ managerId, state, applyDir }) {
  const doneFile = join(applyDir, `${managerId}.done.json`);
  const existingDone = readJson(doneFile);
  if (existingDone) return existingDone;

  const accepted = state.accepted?.[managerId] ?? null;
  if (!accepted) {
    const result = { managerId, missed: true, actions: 0, ok: 0, failed: 0, at: nowIso() };
    writeJsonAtomic(doneFile, result);
    return result;
  }

  const jsonlFile = join(applyDir, `${managerId}.jsonl`);
  const existing = readJsonl(jsonlFile);
  const alreadyOk = new Set(existing.filter((entry) => entry.ok === true).map((entry) => entry.index));
  const ordered = orderActions(accepted.decision.actions ?? []);

  for (const { action, index } of ordered) {
    if (action.type === 'practice') continue; // deferred to its game days
    if (alreadyOk.has(index)) continue;
    const outcome = await actionWithRetry(action, managerId);
    appendJsonl(jsonlFile, {
      index,
      type: action.type,
      action,
      ok: outcome.ok,
      status: outcome.status,
      error: outcome.ok ? null : outcome.body?.error ?? null,
      at: nowIso(),
    });
  }

  const finalRecords = readJsonl(jsonlFile);
  const byIndex = new Map();
  for (const record of finalRecords) byIndex.set(record.index, record);
  const results = [...byIndex.values()];
  const result = {
    managerId,
    missed: false,
    actions: accepted.decision.actions.length,
    applied: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    at: nowIso(),
  };
  writeJsonAtomic(doneFile, result);
  log(`apply ${managerId}: ${result.ok} ok / ${result.failed} failed (of ${result.actions} actions)`);
  return result;
}

async function runPracticeForDay({ day, managers, state, weekDir }) {
  const practiceFile = join(weekDir, `day-${day}.practice.json`);
  const existing = readJson(practiceFile) ?? [];
  const done = new Set(existing.filter((entry) => entry.ok).map((entry) => `${entry.managerId}:${entry.playerId}`));
  const jobs = [];
  for (const managerId of managers) {
    const decision = state.accepted?.[managerId]?.decision;
    if (!decision) continue;
    for (const action of decision.actions ?? []) {
      if (action.type !== 'practice') continue;
      if (!Array.isArray(action.days) || !action.days.includes(day)) continue;
      if (done.has(`${managerId}:${action.playerId}`)) continue;
      jobs.push({ managerId, playerId: action.playerId });
    }
  }
  if (jobs.length === 0) return existing.length;

  const results = await Promise.all(
    jobs.map(async ({ managerId, playerId }) => {
      const outcome = await actionWithRetry({ type: 'practice', playerId }, managerId);
      return {
        managerId,
        playerId,
        day,
        ok: outcome.ok,
        status: outcome.status,
        error: outcome.ok ? null : outcome.body?.error ?? null,
        at: nowIso(),
      };
    }),
  );
  const merged = [...existing, ...results];
  writeJsonAtomic(practiceFile, merged);
  if (results.some((r) => !r.ok)) {
    log(`day ${day}: ${results.filter((r) => !r.ok).length} practice call(s) rejected`, { weekDirRejected: results.filter((r) => !r.ok).length });
  }
  return merged.length;
}

// ---------------------------------------------------------------------------
// Tick driver
// ---------------------------------------------------------------------------

function parseTickProfilePhases(stdout) {
  return stdout
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.msg === 'world-tick-profile')
    .map((entry) => ({ scope: entry.scope, phase: entry.phase, ms: entry.ms, weekIndex: entry.weekIndex }));
}

function tailLines(text, count = 20) {
  return text.split('\n').filter(Boolean).slice(-count).join('\n');
}

function spawnTickOnce(tickIndex, timeoutMs = 60 * 60 * 1000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SOAK_TICK_PATH, '--ticks', '1', '--start', String(tickIndex)], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        WORLD_ID: runCtx.world,
        DATABASE_URL: runCtx.db,
        AUTH_MODE: 'development',
        WORLD_TICK_PROFILE: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolvePromise({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, timedOut: false, stdout, stderr });
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: -1, timedOut: false, stdout, stderr: `${stderr}\nspawn error: ${error.message}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Runner state
// ---------------------------------------------------------------------------

let runCtx = null;
let run = null;
let report = null;
let state = null;
let db = null;
let trackedIds = new Set();
let lockFile = null;
let stopRequested = false;

function persistRun() {
  run.updatedAt = nowIso();
  writeJsonAtomic(join(run.runDir, 'run.json'), run);
}

function persistReport() {
  writeJsonAtomic(join(run.runDir, 'report.json'), report);
}

function persistState() {
  state.updatedAt = nowIso();
  writeJsonAtomic(join(state.weekDir, 'state.json'), state);
}

function updateCurrent(weekIndex, phase, deadlineAt = null) {
  writeJsonAtomic(join(run.runDir, 'CURRENT.json'), {
    runId: run.runId,
    weekIndex,
    week: weekDirName(weekIndex),
    phase,
    deadlineAt,
    updatedAt: nowIso(),
  });
}

function touchLock(extra = {}) {
  if (!lockFile) return;
  const lock = readJson(lockFile) ?? {};
  writeJsonAtomic(lockFile, { ...lock, heartbeatAt: nowIso(), ...extra });
}

function acquireLock() {
  lockFile = join(run.runDir, 'LOCK.json');
  const existing = readJson(lockFile);
  const force = runCtx.forceLock;
  if (existing && !force) {
    const sameHost = existing.host === hostname();
    const pidAlive = sameHost && isPidAlive(existing.pid);
    const age = Date.now() - Date.parse(existing.heartbeatAt ?? 0);
    if (pidAlive) {
      throw new StopRunError(`Another runner is live for this run (pid ${existing.pid}, heartbeat ${existing.heartbeatAt}). Use --force-lock only if you are certain.`, 3);
    }
    if (!sameHost && Number.isFinite(age) && age < runCtx.staleLockMs) {
      throw new StopRunError(`Run lock is held by ${existing.host} with a fresh heartbeat (${existing.heartbeatAt}); wait or use --force-lock.`, 3);
    }
    log('taking over a stale lock', { previousPid: existing.pid, heartbeatAt: existing.heartbeatAt });
  }
  writeJsonAtomic(lockFile, {
    runId: run.runId,
    pid: process.pid,
    host: hostname(),
    acquiredAt: nowIso(),
    heartbeatAt: nowIso(),
  });
  process.on('exit', () => {
    const lock = readJson(lockFile);
    if (lock && lock.pid === process.pid) writeJsonAtomic(lockFile, { ...lock, releasedAt: nowIso(), heartbeatAt: nowIso() });
  });
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function allAccepted() {
  return run.managers.every((managerId) => state.accepted?.[managerId]);
}

function nackCount(managerId) {
  return (state.nackCount?.[managerId] ?? 0) + 1;
}

function recordNack(managerId, file, errors) {
  const attempt = nackCount(managerId);
  state.nackCount = { ...(state.nackCount ?? {}) };
  state.nackCount[managerId] = attempt;
  const nackDir = join(state.weekDir, 'decisions.invalid');
  ensureDir(nackDir);
  const target = join(nackDir, `${managerId}.attempt-${attempt}.json`);
  try {
    renameSync(file, target);
  } catch {
    /* file vanished — still record the NACK */
  }
  const nackFile = join(state.weekDir, 'NACK.json');
  const nackLog = readJson(nackFile) ?? { runId: run.runId, weekIndex: state.weekIndex, attempts: [] };
  nackLog.attempts.push({ managerId, attempt, at: nowIso(), file: target, errors });
  writeJsonAtomic(nackFile, nackLog);
  log(`NACK ${managerId}: ${errors.length} schema error(s)`, { first: errors[0] });
}

/** Validates any not-yet-accepted decision files. Returns how many were accepted. */
function collectDecisionsOnce(open) {
  let changed = false;
  for (const managerId of run.managers) {
    if (state.accepted?.[managerId]) continue;
    const file = join(state.weekDir, 'decisions', `${managerId}.json`);
    if (!existsSync(file)) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      recordNack(managerId, file, [{ path: '$', message: `invalid JSON: ${error.message}` }]);
      changed = true;
      continue;
    }
    const { ok, errors } = validateDecision(parsed, {
      runId: run.runId,
      weekIndex: state.weekIndex,
      managerId,
      currentWeek: open?.clock?.currentWeek ?? state.worldWeek,
    });
    if (!ok) {
      recordNack(managerId, file, errors);
      changed = true;
      continue;
    }
    state.accepted = { ...(state.accepted ?? {}) };
    state.accepted[managerId] = {
      receivedAt: nowIso(),
      summary: parsed.summary,
      actions: parsed.actions.length,
      decision: parsed,
    };
    changed = true;
    log(`accepted decision for ${managerId}`, { actions: parsed.actions.length });
  }
  // Persist acceptance/NACK state immediately so a crash cannot lose a
  // decision or double-count a NACK (the decision file itself is the
  // durable fallback, but the apply phase reads the snapshot in state).
  if (changed) persistState();
  return changed;
}

function anyReadyFile() {
  return run.managers.every((managerId) => existsSync(join(run.runDir, 'agents', managerId, '.ready')));
}

async function phaseOpen() {
  const openFile = join(state.weekDir, 'OPEN.json');
  let open = readJson(openFile);
  if (!open) {
    const startedAt = Date.now();
    const clock = await getClock();
    if (absoWeek(clock.currentWeek) !== absoWeek(state.worldWeek)) {
      throw new StopRunError(
        `world clock (S${clock.currentWeek.season}W${clock.currentWeek.week}) is not this run week (S${state.worldWeek.season}W${state.worldWeek.week}) — refusing to open`,
      );
    }
    state.phase = 'open';
    persistState();
    updateCurrent(state.weekIndex, 'open');
    log(`week ${state.weekIndex} (S${state.worldWeek.season}W${state.worldWeek.week} day ${clock.currentDay}) — building digests`);

    const readyDeadlineAt = new Date(Date.now() + runCtx.readyGateMs).toISOString();
    const decisionDeadlineAt = new Date(Date.now() + runCtx.readyGateMs + runCtx.collectMs).toISOString();
    const digests = {};
    for (const managerId of run.managers) {
      const { digest, trackedPlayerIds } = await buildDigest({
        run,
        weekIndex: state.weekIndex,
        worldWeek: state.worldWeek,
        clock,
        deadlineAt: { readyDeadlineAt, decisionDeadlineAt },
        report,
        managerId,
      });
      trackedPlayerIds.forEach((id) => trackedIds.add(id));
      const file = join(state.weekDir, `digest.${managerId}.json`);
      writeJsonAtomic(file, digest);
      digests[managerId] = { file, bytes: Buffer.byteLength(JSON.stringify(digest)) };
      log(`digest built for ${managerId}`, { bytes: digests[managerId].bytes, roster: digest.roster.length, pool: digest.talentPool.length });
    }
    open = { runId: run.runId, weekIndex: state.weekIndex, worldWeek: state.worldWeek, openedAt: nowIso(), readyDeadlineAt, decisionDeadlineAt, clock, digests };
    writeJsonAtomic(openFile, open);
    state.openMs = (state.openMs ?? 0) + (Date.now() - startedAt);
    state.readyDeadlineAt = readyDeadlineAt;
    state.decisionDeadlineAt = decisionDeadlineAt;
    // The digest builder already fetched each roster — persist the tracked set.
    report.trackedCohort.ids = [...trackedIds];
    persistState();
    persistReport();
    return open;
  }
  return open;
}

async function phaseReadyGate(open) {
  const deadline = Date.parse(open.readyDeadlineAt);
  while (true) {
    collectDecisionsOnce(open);
    if (allAccepted()) return;
    if (anyReadyFile()) return;
    if (Date.now() >= deadline) {
      log('ready gate timed out — entering collect', { readyDeadlineAt: open.readyDeadlineAt });
      return;
    }
    touchLock();
    await sleep(runCtx.pollMs);
  }
}

async function phaseCollect(open) {
  if (!state.collectStartedAt) {
    state.collectStartedAt = nowIso();
    state.collectDeadlineAt = new Date(Date.now() + runCtx.collectMs).toISOString();
    state.nudgeAt = new Date(Date.now() + runCtx.nudgeMs).toISOString();
    state.phase = 'collect';
    persistState();
    updateCurrent(state.weekIndex, 'collect', state.collectDeadlineAt);
    log(`week ${state.weekIndex} collect phase`, { deadlineAt: state.collectDeadlineAt });
  }
  const deadline = Date.parse(state.collectDeadlineAt);
  const nudgeAt = Date.parse(state.nudgeAt);
  while (true) {
    collectDecisionsOnce(open);
    if (allAccepted()) break;
    if (Date.now() >= deadline) {
      const missed = run.managers.filter((managerId) => !state.accepted?.[managerId]);
      state.missed = missed;
      log(`collect deadline reached — missed: ${missed.join(', ') || 'none'}`);
      break;
    }
    if (!state.nudged && Date.now() >= nudgeAt) {
      state.nudged = true;
      for (const managerId of run.managers) {
        if (state.accepted?.[managerId]) continue;
        writeJsonAtomic(join(state.weekDir, 'decisions', `NUDGE.${managerId}.json`), {
          managerId,
          weekIndex: state.weekIndex,
          at: nowIso(),
          message: 'no valid decision received yet — submit before the deadline or the week is recorded as a miss',
          deadlineAt: state.collectDeadlineAt,
        });
      }
      log('nudged managers without a decision');
    }
    touchLock();
    await sleep(runCtx.pollMs);
  }
  if (state.collectMs === undefined) state.collectMs = Date.now() - Date.parse(state.collectStartedAt);
  state.phase = 'apply';
  persistState();
  updateCurrent(state.weekIndex, 'apply');
}

async function phaseApply() {
  const startedAt = Date.now();
  const applyDir = join(state.weekDir, 'apply');
  ensureDir(applyDir);
  const results = await Promise.all(
    run.managers.map((managerId) => applyManager({ managerId, state, applyDir })),
  );
  state.applyMs = (state.applyMs ?? 0) + (Date.now() - startedAt);
  state.applyResults = Object.fromEntries(results.map((r) => [r.managerId, { missed: r.missed, actions: r.actions, ok: r.ok, failed: r.failed }]));
  state.phase = 'advance';
  persistState();
  updateCurrent(state.weekIndex, 'advance');
}

async function runDay({ day, clockBefore }) {
  const startedAt = Date.now();
  const tickIndex = absoDay(clockBefore);
  await runPracticeForDay({ day, managers: run.managers, state, weekDir: state.weekDir });
  touchLock({ currentDay: day });
  const child = await spawnTickOnce(tickIndex);
  const clockAfter = await getClock();
  const advanced = absoDay(clockAfter) === tickIndex + 1;
  const checkpoint = {
    day,
    tickIndex,
    tickKey: `soak-d${tickIndex}`,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: nowIso(),
    elapsedMs: Date.now() - startedAt,
    childExitCode: child.code,
    timedOut: child.timedOut,
    advanced,
    clockBefore: { currentWeek: clockBefore.currentWeek, currentDay: clockBefore.currentDay },
    clockAfter: { currentWeek: clockAfter.currentWeek, currentDay: clockAfter.currentDay },
    profilePhases: parseTickProfilePhases(child.stdout),
    stdoutTail: tailLines(child.stdout),
    stderrTail: tailLines(child.stderr),
  };
  const checkpointFile = join(state.weekDir, `day-${day}.tick.json`);
  if (!advanced || child.code !== 0) {
    checkpoint.partialTickSuspected = advanced && child.code !== 0;
    writeJsonAtomic(checkpointFile, checkpoint);
    state.stopReason = {
      day,
      tickIndex,
      childExitCode: child.code,
      timedOut: child.timedOut,
      advanced,
      partialTickSuspected: checkpoint.partialTickSuspected === true,
    };
    persistState();
    throw new StopRunError(
      `tick for day ${day} FAILED (child exit ${child.code}${child.timedOut ? ', timed out' : ''}, clock ${advanced ? 'moved' : 'did NOT move'}). Stopping rather than continuing; inspect ${checkpointFile} and resume.`,
      3,
    );
  }
  writeJsonAtomic(checkpointFile, checkpoint);
  const phaseMs = checkpoint.elapsedMs;
  state.advanceMs = (state.advanceMs ?? 0) + phaseMs;
  persistState();
  updateCurrent(state.weekIndex, 'advance');
  log(`week ${state.weekIndex} day ${day} ticked`, { tickKey: checkpoint.tickKey, elapsedMs: phaseMs });
  return clockAfter;
}

async function phaseAdvance() {
  let clock = await getClock();
  const weekAbs = absoWeek(state.worldWeek);
  const clockAbs = absoWeek(clock.currentWeek);
  if (clockAbs < weekAbs) {
    throw new StopRunError(`world clock (S${clock.currentWeek.season}W${clock.currentWeek.week}) is BEHIND this run week (S${state.worldWeek.season}W${state.worldWeek.week}) — refusing to continue`);
  }
  if (clockAbs > weekAbs) {
    // A previous process ticked the whole week before being killed. The
    // clock is ground truth: recover checkpoints rather than re-ticking.
    for (let d = 1; d <= DAYS_PER_WEEK; d++) {
      const file = join(state.weekDir, `day-${d}.tick.json`);
      if (!existsSync(file)) writeJsonAtomic(file, { day: d, recovered: true, at: nowIso(), reason: 'world clock had already advanced past this day on resume' });
    }
    log('week already fully ticked according to the world clock — recovered day checkpoints');
    return;
  }

  while (absoWeek(clock.currentWeek) === weekAbs && clock.currentDay <= DAYS_PER_WEEK) {
    if (
      runCtx.stopAfterDay !== null &&
      clock.currentDay > runCtx.stopAfterDay &&
      existsSync(join(state.weekDir, `day-${runCtx.stopAfterDay}.tick.json`))
    ) {
      state.stopReason = { reason: 'stop-after-day', day: runCtx.stopAfterDay, at: nowIso() };
      persistState();
      log(`stopping cleanly after day ${runCtx.stopAfterDay} (--stop-after-day); resume to continue from day ${clock.currentDay}`);
      stopRequested = true;
      return;
    }
    clock = await runDay({ day: clock.currentDay, clockBefore: clock });
  }
}

async function phaseClose() {
  const startedAt = Date.now();
  const clock = await getClock();
  const currentAbs = absoWeek(clock.currentWeek);
  const health = await weeklyHealth(db, currentAbs);
  let pruned = 0;
  if (runCtx.prune) pruned = await pruneStuckTournaments(db, currentAbs);
  let archived = null;
  if (runCtx.archive) archived = await archiveOldMatchRows(db, currentAbs, [...trackedIds]);
  const economy = await snapshotEconomy(db, run.managers);
  const tracked = await snapshotTracked(db, [...trackedIds]);
  report.trackedCohort.weekly.push({
    season: clock.currentWeek.season,
    week: clock.currentWeek.week,
    day: clock.currentDay,
    rows: tracked,
  });
  report.trackedCohort.ids = [...trackedIds];
  report.trackedCohort.sql = `SELECT ... FROM players WHERE id = ANY($1::text[]) ORDER BY id`;

  const decisions = {};
  for (const managerId of run.managers) {
    const accepted = state.accepted?.[managerId] ?? null;
    const applyResult = state.applyResults?.[managerId] ?? null;
    decisions[managerId] = accepted ? 'submitted' : 'missed';
    appendJsonl(join(run.runDir, 'decisions.jsonl'), {
      runId: run.runId,
      weekIndex: state.weekIndex,
      worldWeek: state.worldWeek,
      managerId,
      status: accepted ? 'submitted' : 'missed',
      receivedAt: accepted?.receivedAt ?? null,
      summary: accepted?.summary ?? null,
      actionCount: accepted?.actions ?? 0,
      apply: applyResult,
      nacks: state.nackCount?.[managerId] ?? 0,
      at: nowIso(),
    });
  }

  const advanced = {
    runId: run.runId,
    weekIndex: state.weekIndex,
    worldWeek: state.worldWeek,
    advancedAt: nowIso(),
    endClock: { currentWeek: clock.currentWeek, currentDay: clock.currentDay },
    decisions,
    timingsMs: {
      open: state.openMs ?? 0,
      collect: state.collectMs ?? 0,
      apply: state.applyMs ?? 0,
      advance: state.advanceMs ?? 0,
      close: Date.now() - startedAt,
    },
    dayTicks: Array.from({ length: DAYS_PER_WEEK }, (_, i) => readJson(join(state.weekDir, `day-${i + 1}.tick.json`))).filter(Boolean),
    health,
    prune: { enabled: runCtx.prune, removed: pruned },
    archive: runCtx.archive ? archived : null,
  };
  writeJsonAtomic(join(run.runDir, 'weeks', `${weekDirName(state.weekIndex)}.ADVANCED.json`), advanced);

  report.weeks.push({
    weekIndex: state.weekIndex,
    worldWeek: state.worldWeek,
    startClock: readJson(join(state.weekDir, 'OPEN.json'))?.clock?.currentWeek ?? null,
    endClock: clock.currentWeek,
    endDay: clock.currentDay,
    decisions,
    nacks: state.nackCount ?? {},
    timingsMs: advanced.timingsMs,
    tickCount: advanced.dayTicks.length,
    tickSummary: advanced.dayTicks.map((t) => ({ day: t.day, advanced: t.advanced, elapsedMs: t.elapsedMs, recovered: t.recovered === true })),
    economy,
    health,
    prune: advanced.prune,
    archive: advanced.archive,
  });
  report.meta.endClock = clock;
  state.phase = 'done';
  state.closeMs = Date.now() - startedAt;
  persistState();
  persistReport();
  updateCurrent(state.weekIndex + 1, 'between');
  log(`week ${state.weekIndex} closed`, {
    health,
    pruned: pruned,
    archived: archived ? archived.mainDeleted + archived.doublesDeleted : 0,
    ms: advanced.timingsMs,
  });
}

const PHASES = ['open', 'collect', 'apply', 'advance', 'close'];

async function runWeek(weekIndex) {
  const worldWeek = addWeeks(run.startWeek, weekIndex);
  state = {
    runId: run.runId,
    weekIndex,
    worldWeek,
    weekDir: join(run.runDir, 'weeks', weekDirName(weekIndex)),
    phase: 'open',
    accepted: {},
    nackCount: {},
    updatedAt: nowIso(),
  };
  ensureDir(state.weekDir);
  ensureDir(join(state.weekDir, 'decisions'));
  ensureDir(join(state.weekDir, 'apply'));

  const resumeState = readJson(join(state.weekDir, 'state.json'));
  if (resumeState && resumeState.weekIndex === weekIndex) {
    state = { ...state, ...resumeState, weekDir: state.weekDir };
    log(`resuming week ${weekIndex} in phase "${state.phase}"`, {
      accepted: Object.keys(state.accepted ?? {}),
      nacks: state.nackCount,
    });
  }

  let open = await phaseOpen();
  let phase = state.phase;
  while (phase !== 'done') {
    if (phase === 'open') {
      await phaseReadyGate(open);
      state.phase = 'collect';
      persistState();
      updateCurrent(state.weekIndex, 'collect');
      // fall through immediately: collect handles readiness/decisions.
      await phaseCollect(open);
      phase = 'apply';
      continue;
    }
    if (phase === 'collect') {
      await phaseCollect(open);
      phase = 'apply';
      continue;
    }
    if (phase === 'apply') {
      await phaseApply();
      phase = 'advance';
      continue;
    }
    if (phase === 'advance') {
      await phaseAdvance();
      if (stopRequested) return { stopped: true };
      phase = 'close';
      continue;
    }
    if (phase === 'close') {
      await phaseClose();
      phase = 'done';
      continue;
    }
    throw new StopRunError(`Unknown phase "${phase}" for week ${weekIndex}`);
  }
  return { stopped: false };
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

async function finalize() {
  report.meta.complete = true;
  report.meta.partial = false;
  report.meta.endedAt = nowIso();
  const clock = await getClock();
  report.meta.endClock = clock;
  report.finalCohort = {
    deltas: cohortDeltas(report.trackedCohort.weekly.map((week) => week.rows), report.trackedCohort.ids),
  };

  // The attribute/experience flatness check (the old Skill-rounding bug
  // signature), mirroring soak.mjs's derived anomaly. It never ran here
  // at all before — this harness produced the deltas but dropped them.
  for (const d of report.finalCohort.deltas) {
    if (d.present === false) continue;
    if (d.experienceRisingSkillsFlat) {
      report.anomalies.push({
        type: 'experience-rising-skills-flat',
        playerId: d.id,
        experienceDelta: d.experienceDelta,
        skillsMoved: d.skillsMoved,
        detail: 'Experience accumulated but no skill column moved over the tracked window.',
      });
    }
  }

  if (runCtx.evidence) {
    const evidence = await collectFinalEvidence(db, { ids: [...trackedIds], worldId: runCtx.world, currentAbs: absoWeek(clock.currentWeek) });
    const strategyOutcomes = await collectStrategyOutcomes(db, [...trackedIds]);
    report.evidence = evidence;
    report.strategyOutcomes = strategyOutcomes;
    writeJsonAtomic(join(run.runDir, 'evidence.final.json'), { runId: run.runId, generatedAt: nowIso(), worldId: runCtx.world, trackedIds: [...trackedIds], evidence, strategyOutcomes });

    if (evidence.entryCap.statements[0].rows.length > 0) {
      report.anomalies.push({ type: 'weekly-entry-cap-violation', rows: evidence.entryCap.statements[0].rows });
    }
    const neverStarted = evidence.neverStarted.statements[0].rows;
    const neverConcluded = evidence.neverConcluded.statements[0].rows;
    report.anomalies.push({
      type: 'tournament-never-started',
      finalPrePrune: report.weeks.length > 0 ? Number(report.weeks[report.weeks.length - 1].health?.never_started ?? 0) : 0,
      stillOpenPastWeek: neverStarted.length,
      sample: neverStarted.slice(0, 10),
      note: 'The product has no draw-expiry path; the harness prune removes zero-entrant strays past their week. Counts recorded pre-prune.',
    });
    report.anomalies.push({ type: 'tournament-never-concluded', count: neverConcluded.length, sample: neverConcluded.slice(0, 10) });
    const sanity = evidence.playerStateSanity.statements[0].rows[0];
    if (Number(sanity.out_of_range) > 0) report.anomalies.push({ type: 'player-state-out-of-range', rows: sanity });
    const worldClockRows = evidence.worldClock.statements[0].rows;
    report.anomalies.push({ type: 'world-clock-regressions', count: countClockRegressions(report, worldClockRows) });
  }
  if (http.serverErrors.length > 0) {
    report.anomalies.push({ type: 'http-5xx', count: http.serverErrors.length, sample: http.serverErrors.slice(0, 10) });
  }

  report.managerStats = run.managers.map((managerId) => {
    const weeks = report.weeks;
    const submitted = weeks.filter((week) => week.decisions?.[managerId] === 'submitted');
    const missed = weeks.filter((week) => week.decisions?.[managerId] === 'missed');
    const nacks = weeks.reduce((sum, week) => sum + Number(week.nacks?.[managerId] ?? 0), 0);
    const doneFiles = weeks.map((week) => readJson(join(run.runDir, 'weeks', weekDirName(week.weekIndex), 'apply', `${managerId}.done.json`))).filter(Boolean);
    return {
      managerId,
      decisionsSubmitted: submitted.length,
      decisionsMissed: missed.length,
      nacks,
      actionsTotal: doneFiles.reduce((sum, r) => sum + (r.actions ?? 0), 0),
      actionsOk: doneFiles.reduce((sum, r) => sum + (r.ok ?? 0), 0),
      actionsFailed: doneFiles.reduce((sum, r) => sum + (r.failed ?? 0), 0),
    };
  });

  writeJsonAtomic(join(run.runDir, 'report.json'), report);
  updateCurrent(run.weeksPlanned, 'complete');
  log('RUN COMPLETE', { weeks: report.weeks.length, http: { total: http.total, serverErrors: http.serverErrors.length } });
}

function countClockRegressions(reportData, worldClockRows) {
  let regressions = 0;
  const series = reportData.weeks.map((week) => absoWeek(week.endClock)).filter((v) => Number.isFinite(v));
  for (let i = 1; i < series.length; i++) {
    if (series[i] < series[i - 1]) regressions += 1;
  }
  return regressions;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function validateDbName(dbUrl, allow) {
  let name = '';
  try {
    name = new URL(dbUrl).pathname.replace(/^\//, '');
  } catch {
    throw new StopRunError(`--db is not a valid URL: ${maskDb(dbUrl)}`);
  }
  if (!/agent/i.test(name) && !allow) {
    throw new StopRunError(
      `refusing to run against database "${name}" (must match /agent/i, or pass --allow-db). The harness truncates/prunes tournament rows; never point it at the dev DB.`,
    );
  }
  return name;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  runCtx = {
    api: args.api,
    db: args.db,
    world: args.world,
    forceLock: args.forceLock,
    staleLockMs: args.staleLockMs,
    prune: args.prune,
    archive: args.archive,
    evidence: args.evidence,
    stopAfterDay: args.stopAfterDay,
    readyGateMs: args.readyGateMs,
    collectMs: args.collectMs,
    nudgeMs: args.nudgeMs,
    pollMs: args.pollMs,
  };
  apiBase = args.api;
  ratePerSec = args.ratePerSec;

  const dbName = validateDbName(args.db, args.allowDb);
  const runRoot = resolve(REPO_ROOT, args.runRoot);
  const runId = args.runId ?? `agents-${todayStamp()}`;
  const runDir = join(runRoot, runId);
  const runFile = join(runDir, 'run.json');
  const existingRun = readJson(runFile);
  const fresh = !existingRun;

  if (fresh) {
    ensureDir(runDir);
    ensureDir(join(runDir, 'weeks'));
    ensureDir(join(runDir, 'agents'));
    for (const managerId of args.managers) ensureDir(join(runDir, 'agents', managerId));
    ensureDir(join(runDir, 'protocol'));
  }

  run = existingRun ?? {
    runId,
    runDir,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    api: args.api,
    world: args.world,
    database: maskDb(args.db),
    weeksPlanned: args.weeks,
    managers: args.managers,
    fundXp: args.fundXp,
    protocolVersion: 1,
    runnerVersion: 1,
  };
  run.runDir = runDir; // never trust a moved path from the file — always resolve fresh

  if (existingRun) {
    // On resume, the run file wins for shape; the CLI may override only
    // operational knobs (never the world/manager set/week count).
    if (args.world !== existingRun.world) throw new StopRunError(`--world ${args.world} does not match the run's world ${existingRun.world}`);
    run.managers = existingRun.managers;
    run.weeksPlanned = existingRun.weeksPlanned;
    run.startWeek = existingRun.startWeek;
    log(`resuming run ${runId} at ${runDir}`, { weeksPlanned: run.weeksPlanned, db: dbName });
  } else {
    const clock = await getClock();
    run.startWeek = clock.currentWeek;
    persistRun();
    const protocol = protocolTemplates(run);
    writeFileSync(join(runDir, 'protocol', 'RULES.md'), protocol.rules);
    writeFileSync(join(runDir, 'protocol', 'BOOT_PROMPT.md'), protocol.boot);
    writeFileSync(join(runDir, 'protocol', 'WEEK_PROMPT.md'), protocol.week);
    writeJsonAtomic(join(runDir, 'protocol', 'EXAMPLE_DECISION.json'), protocol.exampleDraft);
    writeJsonAtomic(join(runDir, 'CURRENT.json'), { runId, weekIndex: 0, week: weekDirName(0), phase: 'idle', updatedAt: nowIso() });
    log(`new run ${runId} created`, { startWeek: run.startWeek, db: dbName, world: args.world });
  }

  runnerLogPath = join(runDir, 'runner.log');
  acquireLock();

  const pool = new pg.Pool({ connectionString: args.db, max: 4 });
  db = await pool.connect();

  report = readJson(join(runDir, 'report.json')) ?? {
    meta: {
      kind: 'agent-season',
      runId,
      api: args.api,
      world: args.world,
      database: maskDb(args.db),
      weeksPlanned: run.weeksPlanned,
      managers: run.managers,
      startedAt: nowIso(),
      endedAt: null,
      startClock: null,
      endClock: null,
      startWeek: run.startWeek,
      complete: false,
      partial: true,
    },
    managers: run.managers.map((managerId) => ({ managerId, fundedXp: fresh ? args.fundXp : null })),
    http,
    weeks: [],
    trackedCohort: { sql: null, ids: [], weekly: [] },
    finalCohort: null,
    evidence: null,
    strategyOutcomes: null,
    anomalies: [],
    managerStats: null,
  };
  if (report.meta.complete) {
    log('report is already complete; nothing to do');
    updateCurrent(run.weeksPlanned, 'complete');
    db.release();
    await pool.end();
    process.exit(0);
  }
  report.meta.api = args.api;
  report.meta.managers = run.managers;
  report.meta.weeksPlanned = run.weeksPlanned;
  // Restore the persisted HTTP ledger before rebinding it, so a resumed
  // run keeps its accumulated totals rather than restarting the counters.
  if (report.http) {
    Object.assign(http, report.http);
    for (const key of ['serverErrors', 'unexpected4xx']) http[key] = Array.isArray(http[key]) ? http[key] : [];
  }
  report.http = http;
  trackedIds = new Set(report.trackedCohort?.ids ?? []);

  // Boot checks: never run while another tick driver is live.
  if (!args.skipHeartbeatCheck) {
    const before = await getClock();
    await sleep(10_000);
    const after = await getClock();
    if ((before.lastTickAt ?? null) !== (after.lastTickAt ?? null)) {
      throw new StopRunError(
        `another tick driver is live: /world/clock lastTickAt moved from ${before.lastTickAt} to ${after.lastTickAt} during the 10s boot check. Stop the worker (or any other driver) and retry.`,
      );
    }
    log('boot heartbeat check passed (no other tick driver)', { lastTickAt: after.lastTickAt });
  }

  if (fresh) {
    report.meta.startClock = await getClock();
    for (const managerId of run.managers) {
      await api('GET', '/me/entitlement', undefined, managerId); // creates the account
      await q(
        db,
        `INSERT INTO manager_progression (manager_id, xp_balance, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (manager_id) DO UPDATE SET xp_balance = EXCLUDED.xp_balance, updated_at = now()`,
        [managerId, args.fundXp],
      );
      log(`funded ${managerId}`, { xp: args.fundXp });
    }
    report.meta.bootstrapNormalized = await normalizeBootstrap(db, absoWeek(report.meta.startClock.currentWeek));
    log('normalized bootstrap far-future opens', { removed: report.meta.bootstrapNormalized });
    persistReport();
  }

  // Position from the file system: newest ADVANCED week + 1.
  let completed = 0;
  for (let i = 0; i < run.weeksPlanned; i++) {
    if (existsSync(join(runDir, 'weeks', `${weekDirName(i)}.ADVANCED.json`))) completed = i + 1;
  }
  log(`file-system position: ${completed}/${run.weeksPlanned} weeks advanced`);

  for (let weekIndex = completed; weekIndex < run.weeksPlanned; weekIndex++) {
    const result = await runWeek(weekIndex);
    if (result.stopped) {
      log('stopped cleanly — rerun the same command to resume');
      persistReport();
      db.release();
      await pool.end();
      process.exit(0);
    }
  }

  await finalize();
  db.release();
  await pool.end();
  printSummary();
  process.exit(0);
}

function printSummary() {
  console.log('\n========== AGENT-SEASON SUMMARY ==========');
  console.log(`Run: ${run.runId} | weeks: ${report.weeks.length}/${report.meta.weeksPlanned} | complete: ${report.meta.complete}`);
  console.log(`HTTP: ${http.total} | 5xx: ${http.serverErrors.length} | unexpected 4xx: ${http.unexpected4xx.length} | concurrency 409: ${http.concurrencyConflicts}`);
  console.log(`Tracked players: ${report.trackedCohort.ids.length}`);
  for (const stats of report.managerStats ?? []) {
    console.log(
      `  ${stats.managerId}: decisions ${stats.decisionsSubmitted} submitted / ${stats.decisionsMissed} missed | nacks ${stats.nacks} | actions ${stats.actionsOk} ok / ${stats.actionsFailed} failed`,
    );
  }
  for (const anomaly of report.anomalies ?? []) console.log(`  [anomaly] ${anomaly.type}: ${JSON.stringify(anomaly).slice(0, 200)}`);
  console.log(`Full report: ${join(run.runDir, 'report.json')}`);
}

main().catch((error) => {
  if (error instanceof StopRunError) {
    console.error(`[agent-season] STOPPED: ${error.message}`);
    if (report) {
      report.anomalies = report.anomalies ?? [];
      report.anomalies.push({ type: 'run-stopped', message: error.message, at: nowIso() });
      try {
        persistReport();
      } catch {
        /* best effort */
      }
    }
    process.exit(error.exitCode);
  }
  console.error('agent-season failed:', error);
  process.exit(1);
});
