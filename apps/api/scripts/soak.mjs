#!/usr/bin/env node
/**
 * Multi-manager, multi-season SOAK harness.
 *
 * Drives eight managers with genuinely different strategies through the real
 * HTTP game loop for `SOAK_WEEKS` (default 156 = 3 seasons) game-weeks. Each
 * game-week: everyone makes decisions over HTTP, then the REAL day-tick
 * pipeline is advanced 7 days via a spawned `soakTick.js` process (no Redis,
 * no waiting), then raw-SQL evidence is snapshotted.
 *
 * WHY A SEPARATE DATABASE: `players` and `tournaments` have no `world_id`
 * column (multi-world is deferred in the schema), so `WORLD_ID=soak` does NOT
 * isolate player/tournament data — only the `game_worlds` clock row and the
 * ranking reads that are built once against `WORLD_ID`. Running this against
 * the dev `tennis_manager` DB would therefore mix the soak into whatever
 * `main` already holds and make every SQL-backed claim ambiguous. This script
 * is designed to run against a DEDICATED database (`tennis_manager_soak`) with
 * `WORLD_ID=soak` on every process. That is a real gap in the "isolated world"
 * idea, not a harness convenience — see the report.
 *
 * EVERY CLAIM IS SQL-BACKED. The JSON report carries, per evidence category,
 * the exact SQL and its raw result rows. Never a narrative.
 *
 * Usage:
 *   node apps/api/scripts/soak.mjs
 *   SOAK_WEEKS=3 SOAK_REPORT=soak-smoke.json node apps/api/scripts/soak.mjs
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
// The SQL-backed evidence collectors live in lib/soakEvidence.mjs, shared
// byte-for-byte with agentSeason.mjs (the agent-played-season harness) so
// the two evidence sets are provably the same queries.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

const API = process.env.API_BASE ?? 'http://localhost:3000';
const WORLD = process.env.WORLD_ID ?? 'soak';
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager_soak';
const RATE_PER_SEC = Number(process.env.SOAK_RATE_PER_SEC ?? 4.5); // < API's 300/min
const WEEK_COUNT = Number(process.env.SOAK_WEEKS ?? 156);
const TICKS_PER_WEEK = 7;
const XP_PER_BOT = Number(process.env.SOAK_XP ?? 100_000);
const REPORT_PATH = process.env.SOAK_REPORT ?? resolve(REPO_ROOT, 'soak-report.json');
const BOOTSTRAP_FILE = process.env.SOAK_BOOTSTRAP_FILE ?? null;
const SOAK_TICK_PATH = join(REPO_ROOT, 'apps', 'worker', 'dist', 'scripts', 'soakTick.js');
// HARNESS MITIGATION (disclosed): the product has no tournament-expiry path,
// so tournaments whose draw never fills stay open forever and are re-processed
// by StartDueTournamentsUseCase on every weekly rollover — which is both a real
// product finding AND the reason a 156-week run is otherwise quadratically
// slow. When enabled, this deletes only NEVER-STARTED, ZERO-ENTRANT open
// tournaments more than 3 weeks past their scheduled week (they carry no
// entries, matches, titles or ranking rows to lose), AFTER snapshotting the
// pile size. The pre-prune count is recorded per week; the product gap stays a
// headline finding. Set SOAK_PRUNE_STUCK=0 to disable (and expect a very slow
// run).
const PRUNE_STUCK = (process.env.SOAK_PRUNE_STUCK ?? '1') !== '0';
// See archiveOldMatchRows. Default on; set SOAK_ARCHIVE=0 to disable.
const ARCHIVE_MATCHES = (process.env.SOAK_ARCHIVE ?? '1') !== '0';

const U14_MAX_WEEKS = 14 * 52;
const U16_MAX_WEEKS = 16 * 52;
const U18_MAX_WEEKS = 18 * 52;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Global token bucket: stay under the API's 300/min per-IP limit ----
let nextSlot = 0;
function acquireSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 1000 / RATE_PER_SEC;
  return sleep(slot - now);
}

const report = {
  meta: {
    api: API,
    world: WORLD,
    database: DB_URL.replace(/:[^:@/]+@/, ':***@'),
    weeksPlanned: WEEK_COUNT,
    startedAt: new Date().toISOString(),
    endedAt: null,
    startClock: null,
    endClock: null,
  },
  bootstrap: null,
  strategies: [],
  http: { total: 0, byRoute: {}, serverErrors: [], unexpected4xx: [], ruleRejections: {}, concurrencyConflicts: 0 },
  weeks: [],
  trackedCohort: { sql: null, ids: [], weekly: [] },
  finalCohort: null,
  evidence: null,
  anomalies: [],
  strategyOutcomes: null,
};

const EXPECTED_RULE_SUBSTRINGS = [
  'insufficient xp', 'roster is full', 'at capacity', 'already', 'age', 'cap',
  'must not have an ageband', 'does not support', 'not eligible', 'not found in your roster',
  'not found', 'week', 'registered', 'too old', 'entry', 'slot', 'claim', 'pair',
  'qualifying field is already full', 'outside direct acceptance', 'retired', 'cannot enter',
  'not on manager', 'no longer available', 'reached the weekly limit', 'has already entered',
  'free agent', 'is not on', 'unavailable',
];

const ROUTE_PATTERNS = [
  [/^\/talent-pool\/[^/]+\/claim$/, '/talent-pool/:id/claim'],
  [/^\/tournaments\/[^/]+\/entrants$/, '/tournaments/:id/entrants'],
  [/^\/tournaments\/[^/]+\/doubles-entrants$/, '/tournaments/:id/doubles-entrants'],
  [/^\/players\/[^/]+\/training-focus$/, '/players/:id/training-focus'],
  [/^\/players\/[^/]+\/practice$/, '/players/:id/practice'],
  [/^\/players\/[^/]+\/profile$/, '/players/:id/profile'],
  [/^\/players\/[^/]+\/ranking$/, '/players/:id/ranking'],
  [/^\/players\/[^/]+\/current-matches$/, '/players/:id/current-matches'],
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

/** HTTP with the shared token bucket, retries, and a route x status ledger. */
async function api(method, path, body, managerId) {
  const key = routeKey(method, path);
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (managerId) headers['x-dev-manager-id'] = managerId;

  for (let attempt = 0; attempt < 5; attempt++) {
    await acquireSlot();
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      recordHttp(key, res.status, method, path, json, managerId);
      return { status: res.status, ok: res.ok, body: json };
    } catch (e) {
      await sleep(800);
    }
  }
  recordHttp(key, 0, method, path, { error: 'network failure after retries' }, managerId);
  return { status: 0, ok: false, body: { error: 'network failure after retries' } };
}

function recordHttp(key, status, method, path, body, managerId) {
  report.http.total += 1;
  const bucket = (report.http.byRoute[key] ??= {});
  bucket[status] = (bucket[status] ?? 0) + 1;
  if (status >= 500 || status === 0) {
    report.http.serverErrors.push({ method, path, status, body, managerId });
    return;
  }
  if (status >= 400) {
    const message = String(body?.error ?? '');
    // The tournament repository's optimistic-concurrency guard returns a
    // retryable 409 when two managers register for the SAME tournament
    // within the same moment. That is a transient write conflict, not a
    // game-rule rejection and not an unexpected failure — counted on its
    // own line.
    if (message.toLowerCase().includes('modified by another request')) {
      report.http.concurrencyConflicts += 1;
      return;
    }
    const expected = message === '' || EXPECTED_RULE_SUBSTRINGS.some((s) => message.toLowerCase().includes(s));
    if (expected) {
      const k = message || `${status} (no message)`;
      report.http.ruleRejections[k] = (report.http.ruleRejections[k] ?? 0) + 1;
    } else {
      report.http.unexpected4xx.push({ method, path, status, body, managerId });
    }
  }
}

// ---- Strategies ----
const TIER_PRESTIGE = {
  futures: 1, challenger: 2, tour: 3, major: 4,
  j30: 1, j60: 2, j100: 3, j200: 4, j300: 5, j500: 6, juniorMasters: 7,
};
const SENIOR_TIERS = ['futures', 'challenger', 'tour', 'major'];
const JUNIOR_TIERS = ['j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'];

function overallOf(p) {
  const a = p.attributes;
  const vals = [
    a.technical.serve, a.technical.forehand, a.technical.backhand, a.technical.volley,
    a.physical.speed, a.physical.stamina, a.physical.strength,
    a.mental.consistency, a.mental.clutch,
  ];
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
function maxAffinity(p) {
  const s = p.attributes.surfaceAffinities;
  return Math.max(s.clay, s.grass, s.hard, s.indoor);
}
const isJuniorTournament = (t) => t.ageBand !== null;

const STRATEGIES = [
  {
    id: 'tier-fit',
    label: 'Enter the draw matching roster OVR',
    ageTarget: 'senior',
    action: 'singles',
    practice: false,
    actThisWeek: () => true,
    focusEvery: 4,
    trainingFocus: () => ({ kind: 'attribute', attribute: 'serve' }),
    claimScore: (a) => overallOf(a),
    pickTournament: (cands, p) => {
      const ovr = overallOf(p);
      const want = ovr < 45 ? 1 : ovr < 55 ? 2 : ovr < 65 ? 3 : 4;
      return bestBy(cands, (t) => -Math.abs(TIER_PRESTIGE[t.tier] - want));
    },
  },
  {
    id: 'quality-chaser',
    label: 'Always the largest tier eligible (tier-mismatch probe)',
    ageTarget: 'senior',
    action: 'singles',
    practice: false,
    actThisWeek: () => true,
    focusEvery: 4,
    trainingFocus: () => ({ kind: 'attribute', attribute: 'serve' }),
    claimScore: (a) => overallOf(a),
    pickTournament: (cands) => bestBy(cands, (t) => TIER_PRESTIGE[t.tier] * 100 + t.drawSize),
  },
  {
    id: 'grinder',
    label: 'Enter every week; doubles when the cap allows',
    ageTarget: 'senior',
    action: 'grinder',
    practice: true,
    actThisWeek: () => true,
    focusEvery: 8,
    trainingFocus: () => ({ kind: 'attribute', attribute: 'stamina' }),
    claimScore: (a) => a.attributes.physical.stamina,
    pickTournament: (cands) => bestBy(cands, (t) => t.drawSize),
  },
  {
    id: 'rest-and-train',
    label: 'Skip alternate weeks; train every week',
    ageTarget: 'junior',
    action: 'singles',
    practice: true,
    actThisWeek: (w) => w % 2 === 0,
    focusEvery: 1,
    trainingFocus: () => ({ kind: 'attribute', attribute: 'forehand' }),
    claimScore: (a) => -a.ageInWeeks,
    pickTournament: (cands, p) => {
      const ovr = overallOf(p);
      const want = ovr < 45 ? 1 : ovr < 55 ? 2 : 3;
      return bestBy(cands, (t) => -Math.abs(TIER_PRESTIGE[t.tier] - want));
    },
  },
  {
    id: 'doubles-focused',
    label: 'Enter doubles every week instead of singles',
    ageTarget: 'senior',
    action: 'doubles',
    practice: false,
    actThisWeek: () => true,
    focusEvery: 6,
    trainingFocus: () => ({ kind: 'attribute', attribute: 'volley' }),
    claimScore: (a) => a.attributes.doubles,
    pickTournament: (cands) => {
      const withDoubles = cands.filter((t) => t.doublesDrawSize > 0);
      const pool = withDoubles.length > 0 ? withDoubles : cands;
      return bestBy(pool, (t) => t.doublesDrawSize * 100 + TIER_PRESTIGE[t.tier]);
    },
  },
  {
    id: 'junior-ladder',
    label: 'Climb the junior ladder, highest eligible band/grade',
    ageTarget: 'junior',
    action: 'singles',
    practice: true,
    actThisWeek: () => true,
    focusEvery: 4,
    trainingFocus: () => ({ kind: 'attribute', attribute: 'backhand' }),
    claimScore: (a) => -a.ageInWeeks,
    pickTournament: (cands) => {
      const junior = cands.filter(isJuniorTournament);
      const pool = junior.length > 0 ? junior : cands;
      const bandRank = { u14: 1, u16: 2, u18: 3 };
      return bestBy(pool, (t) => (t.ageBand ? bandRank[t.ageBand] : 0) * 100 + TIER_PRESTIGE[t.tier]);
    },
  },
  {
    id: 'value-hunter',
    label: 'Lowest tier available (maximise win chance)',
    ageTarget: 'senior',
    action: 'singles',
    practice: false,
    actThisWeek: () => true,
    focusEvery: 6,
    trainingFocus: () => ({ kind: 'attribute', attribute: 'strength' }),
    claimScore: (a) => -a.claimCost,
    pickTournament: (cands) => bestBy(cands, (t) => -TIER_PRESTIGE[t.tier] * 100 - t.drawSize),
  },
  {
    id: 'surface-specialist',
    label: 'Enter the best-fitting surface',
    ageTarget: 'senior',
    action: 'singles',
    practice: false,
    actThisWeek: () => true,
    focusEvery: 4,
    trainingFocus: (player) => {
      const s = player.attributes.surfaceAffinities;
      const best = ['clay', 'grass', 'hard', 'indoor'].sort((a, b) => s[b] - s[a])[0];
      const bySurface = { clay: 'stamina', grass: 'volley', hard: 'serve', indoor: 'serve' };
      return { kind: 'attribute', attribute: bySurface[best] };
    },
    claimScore: (a) => maxAffinity(a),
    pickTournament: (cands, p) => {
      const s = p.attributes.surfaceAffinities;
      return bestBy(cands, (t) => s[t.surface] * 100 + TIER_PRESTIGE[t.tier]);
    },
  },
];

function bestBy(arr, scoreFn) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of arr) {
    const s = scoreFn(item);
    if (s > bestScore) { best = item; bestScore = s; }
  }
  return best;
}

// ---- Runtime state ----
const runtime = {
  bots: [],
  trackedIds: new Set(),
  claimedAgentIds: new Set(),
  agents: [],
  entriesThisWeek: new Map(), // `${playerId}:${absoWeek}` -> count
};

function botIds() {
  return STRATEGIES.map((s) => `soak-${s.id}`);
}

// ---- Per-week bot decision pass ----
async function fetchPool() {
  const res = await api('GET', '/talent-pool');
  return res.ok && Array.isArray(res.body) ? res.body : [];
}

async function claimAgentsFor(bot, clock) {
  const cap = 2; // all soak managers are free tier
  const roster = bot.roster.filter((p) => p.stage !== 'retired');
  let need = cap - roster.length;
  if (need <= 0) return;
  const ent = await api('GET', '/me/entitlement', undefined, bot.id);
  const xp = ent.ok ? ent.body.xpBalance : 0;
  const bucket = runtime.agents.filter((a) => {
    if (runtime.claimedAgentIds.has(a.id)) return false;
    if (a.claimCost > xp) return false;
    return bot.strategy.ageTarget === 'junior' ? a.ageInWeeks <= U16_MAX_WEEKS : a.ageInWeeks > U18_MAX_WEEKS;
  });
  // deterministic disjoint pick: offset each bot by its strategy index
  const offset = bot.index * 3;
  const ordered = bucket.slice(offset).concat(bucket.slice(0, offset));
  const sorted = ordered.sort((a, b) => bot.strategy.claimScore(b) - bot.strategy.claimScore(a));
  for (const agent of sorted) {
    if (need <= 0) break;
    if (runtime.claimedAgentIds.has(agent.id)) continue;
    const res = await api('POST', `/talent-pool/${encodeURIComponent(agent.id)}/claim`, { managerId: bot.id }, bot.id);
    runtime.claimedAgentIds.add(agent.id);
    if (res.ok) {
      need -= 1;
      bot.roster.push(res.body);
      runtime.trackedIds.add(res.body.id);
      bot.claims.push({ agentId: agent.id, status: res.status, ok: true });
    } else {
      bot.claims.push({ agentId: agent.id, status: res.status, error: res.body?.error, ok: false });
    }
  }
}

async function ensurePair(bot) {
  if (bot.pairId) return bot.pairId;
  const active = bot.roster.filter((p) => p.stage !== 'retired');
  if (active.length < 2) return null;
  const existing = await api('GET', '/me/doubles-pairs', undefined, bot.id);
  if (existing.ok && Array.isArray(existing.body)) {
    const live = existing.body.find((p) => p.status === 'active' || p.status === 'pending');
    if (live) { bot.pairId = live.id; return bot.pairId; }
  }
  const res = await api('POST', '/doubles-pairs', { playerA: active[0].id, playerB: active[1].id }, bot.id);
  if (res.ok) bot.pairId = res.body.id;
  return bot.pairId;
}

function enterableCandidates(cands, player, currentAbs) {
  const filtered = cands.filter((t) => {
    if (t.hasStarted) return false;
    if (t.ageEligible === false) return false;
    if (t.weeklyEntryCountThisWeek !== undefined && t.weeklyEntryCapThisWeek !== undefined
        && t.weeklyEntryCountThisWeek >= t.weeklyEntryCapThisWeek) return false;
    const roomInMain = t.entrants.length < t.drawSize;
    const roomInQualifying = t.entryViaQualifying === true && t.qualifyingFieldFull !== true;
    if (!roomInMain && !roomInQualifying) return false;
    return absoWeek(t.weekScheduled) >= currentAbs;
  });
  if (filtered.length === 0) return [];
  const nearest = Math.min(...filtered.map((t) => absoWeek(t.weekScheduled)));
  return filtered.filter((t) => absoWeek(t.weekScheduled) === nearest);
}

/** One retry on the repository's retryable optimistic-concurrency 409. */
async function postWithRetry(path, body, bot) {
  let res = await api('POST', path, body, bot.id);
  if (res.status === 409 && String(res.body?.error ?? '').includes('modified by another request')) {
    res = await api('POST', path, body, bot.id);
  }
  return res;
}

async function enterForPlayer(bot, player, clock) {
  if (player.stage === 'retired') return;
  const currentAbs = absoWeek(clock.currentWeek);
  const list = await api('GET', `/tournaments?status=open&playerId=${encodeURIComponent(player.id)}`, undefined, bot.id);
  const cands = Array.isArray(list.body) ? list.body : [];
  const weekCands = enterableCandidates(cands, player, currentAbs);
  if (weekCands.length === 0) {
    bot.noTournamentWeeks.push({ playerId: player.id, week: clock.currentWeek });
    return;
  }
  const chosen = bot.strategy.pickTournament(weekCands, player);
  if (!chosen) return;

  const wantDoubles = bot.strategy.action === 'doubles' || bot.strategy.action === 'grinder';
  const doDoubles = () => chosen.doublesDrawSize > 0 && chosen.doublesEntrants.length < chosen.doublesDrawSize;

  if (bot.strategy.action === 'doubles') {
    if (doDoubles()) {
      const res = await postWithRetry(`/tournaments/${encodeURIComponent(chosen.id)}/doubles-entrants`, { playerId: player.id }, bot);
      if (res.ok) bot.entries.push({ playerId: player.id, tournamentId: chosen.id, tier: chosen.tier, kind: 'doubles' });
    }
    return;
  }

  const singles = await postWithRetry(`/tournaments/${encodeURIComponent(chosen.id)}/entrants`, { playerId: player.id }, bot);
  if (singles.ok) {
    bot.entries.push({ playerId: player.id, tournamentId: chosen.id, tier: chosen.tier, kind: 'singles' });
  } else {
    bot.entryFailures.push({ playerId: player.id, tournamentId: chosen.id, status: singles.status, error: singles.body?.error });
  }
  // Grinder: attempt doubles too. The senior cap (1/week) refuses it after a
  // singles entry in the same week; the refusal is recorded as a rule
  // rejection, not an anomaly. Junior (cap 3) can genuinely play both.
  if (wantDoubles && doDoubles()) {
    const res = await postWithRetry(`/tournaments/${encodeURIComponent(chosen.id)}/doubles-entrants`, { playerId: player.id }, bot);
    if (res.ok) bot.entries.push({ playerId: player.id, tournamentId: chosen.id, tier: chosen.tier, kind: 'doubles' });
  }
}

async function decisionPassForBot(bot, clock, weekIndex) {
  await api('GET', '/auth/me', undefined, bot.id);
  const me = await api('GET', '/me/players', undefined, bot.id);
  if (me.ok && Array.isArray(me.body)) bot.roster = me.body;

  await claimAgentsFor(bot, clock);

  const active = bot.roster.filter((p) => p.stage !== 'retired');
  if (bot.strategy.action === 'doubles') await ensurePair(bot);

  if (!bot.strategy.actThisWeek(weekIndex)) return;

  for (const player of active) {
    // Training focus (schedule entry), periodically.
    if (weekIndex % bot.strategy.focusEvery === 0) {
      const focus = bot.strategy.trainingFocus(player);
      const res = await api('PUT', `/players/${encodeURIComponent(player.id)}/training-focus`, { focus }, bot.id);
      if (res.ok) bot.focusSets += 1;
    }
    // Practice, periodically.
    if (bot.strategy.practice && weekIndex % 2 === 0) {
      const res = await api('POST', `/players/${encodeURIComponent(player.id)}/practice`, undefined, bot.id);
      if (res.ok) bot.practices += 1;
    }
    await enterForPlayer(bot, player, clock);
  }
}

// ---- Tick driver ----
function spawnTicks(ticks, startIndex) {
  if (!existsSync(SOAK_TICK_PATH)) {
    throw new Error(`soak tick script not built at ${SOAK_TICK_PATH} — run "npx tsc --build" first`);
  }
  const res = spawnSync('node', [SOAK_TICK_PATH, '--ticks', String(ticks), '--start', String(startIndex)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
    env: { ...process.env, WORLD_ID: WORLD, DATABASE_URL: DB_URL, AUTH_MODE: 'development' },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// ---- Resumable state (so a 156-week run survives tool/command timeouts) ----
const CHUNK_SECONDS = Number(process.env.SOAK_CHUNK_SECONDS ?? 0); // 0 = run to completion
const RESUMABLE = process.env.SOAK_RESUME === '1';

/** Serialises the in-memory runtime into the report so a later chunk can resume. */
function stateFromRuntime(weekIndex, cumulativeTick) {
  return {
    weekIndex,
    cumulativeTick,
    complete: false,
    trackedIds: [...runtime.trackedIds],
    claimedAgentIds: [...runtime.claimedAgentIds],
    bots: runtime.bots.map((bot) => ({
      id: bot.id,
      strategyId: bot.strategy.id,
      claims: bot.claims,
      entries: bot.entries,
      entryFailures: bot.entryFailures,
      noTournamentWeeks: bot.noTournamentWeeks,
      focusSets: bot.focusSets,
      practices: bot.practices,
      pairId: bot.pairId,
    })),
  };
}

/** Rebuilds the runtime bots from a serialised state; strategies reattach by id. */
function restoreBots(stateBots) {
  return (stateBots ?? []).map((sb, index) => ({
    id: sb.id,
    index,
    strategy: STRATEGIES.find((s) => s.id === sb.strategyId) ?? STRATEGIES[index],
    roster: [],
    claims: sb.claims ?? [],
    entries: sb.entries ?? [],
    entryFailures: sb.entryFailures ?? [],
    noTournamentWeeks: sb.noTournamentWeeks ?? [],
    focusSets: sb.focusSets ?? 0,
    practices: sb.practices ?? 0,
    pairId: sb.pairId ?? null,
  }));
}

function saveCheckpoint() {
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

// ---- Main ----
async function main() {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  const db = await pool.connect();

  const resume = RESUMABLE && existsSync(REPORT_PATH);
  if (resume) {
    Object.assign(report, JSON.parse(readFileSync(REPORT_PATH, 'utf8')));
    if (report.state?.complete) {
      console.log('soak report is already complete; nothing to do');
      db.release();
      await pool.end();
      printSummary();
      return;
    }
  }
  if (BOOTSTRAP_FILE && existsSync(BOOTSTRAP_FILE)) {
    report.bootstrap = readFileSync(BOOTSTRAP_FILE, 'utf8');
  }

  const startClock = await api('GET', '/world/clock');
  if (!startClock.ok) throw new Error(`API /world/clock not reachable at ${API} — is it running with WORLD_ID=${WORLD}?`);

  const ids = botIds();
  if (!resume) {
    report.meta.startedAt = new Date().toISOString();
    report.meta.startClock = startClock.body;
    report.meta.pruneStuck = PRUNE_STUCK;
    // XP has no HTTP grant endpoint, so pre-fund each manager directly (the
    // same direct upsert apps/api/scripts/playtest.mjs uses). Only on a
    // fresh start — re-funding on resume would erase earned XP and corrupt
    // the economy-drift evidence.
    for (const id of ids) {
      await q(
        db,
        `INSERT INTO manager_progression (manager_id, xp_balance, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (manager_id) DO UPDATE SET xp_balance = EXCLUDED.xp_balance, updated_at = now()`,
        [id, XP_PER_BOT],
      );
    }
    runtime.agents = await fetchPool();
    runtime.bots = STRATEGIES.map((strategy, index) => ({
      id: ids[index],
      index,
      strategy,
      roster: [],
      claims: [],
      entries: [],
      entryFailures: [],
      noTournamentWeeks: [],
      focusSets: 0,
      practices: 0,
      pairId: null,
    }));
    report.strategies = STRATEGIES.map((s) => ({ id: s.id, label: s.label, ageTarget: s.ageTarget, action: s.action }));
    report.meta.resumedAt = null;
    // See normalizeBootstrap: shrink the bootstrap's over-broad open set to a
    // production-like one before the first week runs.
    report.meta.bootstrapNormalized = await normalizeBootstrap(db, absoWeek(startClock.body.currentWeek));
  } else {
    report.meta.resumedAt = new Date().toISOString();
    runtime.agents = await fetchPool();
    runtime.trackedIds = new Set(report.state.trackedIds ?? []);
    runtime.claimedAgentIds = new Set(report.state.claimedAgentIds ?? []);
    runtime.bots = restoreBots(report.state.bots);
    console.log(`[soak] resuming at week ${report.state.weekIndex}/${WEEK_COUNT} (tick ${report.state.cumulativeTick})`);
  }

  let cumulativeTick = resume ? report.state.cumulativeTick : 0;
  const startWeekIndex = resume ? report.state.weekIndex : 0;
  const chunkStart = Date.now();

  for (let w = startWeekIndex; w < WEEK_COUNT; w++) {
    const weekStart = Date.now();
    const clockRes = await api('GET', '/world/clock');
    const clock = clockRes.body;

    // Decision pass (bots concurrently; the token bucket serialises the rate).
    await Promise.all(runtime.bots.map((bot) => decisionPassForBot(bot, clock, w)));

    // Drive 7 real day-ticks.
    const tick = spawnTicks(TICKS_PER_WEEK, cumulativeTick);
    cumulativeTick += TICKS_PER_WEEK;
    const lastLine = tick.stdout.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    let tickSummary = null;
    try { tickSummary = JSON.parse(lastLine); } catch { /* not the JSON line */ }

    if (tick.status !== 0) {
      report.anomalies.push({
        type: 'tick-driver-failed',
        weekIndex: w,
        clock: clock.currentWeek,
        status: tick.status,
        stderrTail: tick.stderr.split('\n').slice(-20).join('\n'),
      });
      // Continue: one failed week is reported, but the world may still be
      // usable for the remaining weeks.
    }

    // Evidence snapshot for this week (SQL-backed).
    const tracked = await snapshotTracked(db, [...runtime.trackedIds]);
    const economy = await snapshotEconomy(db, ids);
    const afterClock = (await api('GET', '/world/clock')).body;
    const health = await weeklyHealth(db, absoWeek(afterClock.currentWeek));
    report.weeks.push({
      weekIndex: w,
      startClock: clock.currentWeek,
      startDay: clock.currentDay,
      endClock: afterClock.currentWeek,
      endDay: afterClock.currentDay,
      tickKeyRange: [`soak-d${cumulativeTick - 7}`, `soak-d${cumulativeTick - 1}`],
      tickSummary,
      economy,
      health,
      durationSeconds: Number(((Date.now() - weekStart) / 1000).toFixed(1)),
    });
    // Mitigation AFTER snapshotting the pile size — see PRUNE_STUCK.
    if (PRUNE_STUCK) {
      const pruned = await pruneStuckTournaments(db, absoWeek(afterClock.currentWeek));
      report.weeks[report.weeks.length - 1].stuckPruned = pruned;
    }
    if (ARCHIVE_MATCHES) {
      const archived = await archiveOldMatchRows(db, absoWeek(afterClock.currentWeek), [...runtime.trackedIds]);
      report.weeks[report.weeks.length - 1].archived = archived;
    }
    if (tracked.length > 0 && report.trackedCohort.ids.length === 0) {
      report.trackedCohort.ids = tracked.map((r) => r.id);
    }
    report.trackedCohort.weekly.push({
      season: afterClock.currentWeek.season,
      week: afterClock.currentWeek.week,
      day: afterClock.currentDay,
      rows: tracked,
    });

    report.state = stateFromRuntime(w + 1, cumulativeTick);
    saveCheckpoint();

    if ((w + 1) % 13 === 0 || w === WEEK_COUNT - 1) {
      const c = afterClock.currentWeek;
      console.log(
        `[soak] week ${w + 1}/${WEEK_COUNT} — S${c.season}W${c.week} day ${afterClock.currentDay} ` +
          `(5xx=${report.http.serverErrors.length}, tracked=${runtime.trackedIds.size}, ${((Date.now() - weekStart) / 1000).toFixed(0)}s)`,
      );
    }
    if (w % 8 === 0) runtime.agents = await fetchPool();

    // Bounded chunk: stop cleanly and let a later SOAK_RESUME=1 run continue.
    if (CHUNK_SECONDS > 0 && (Date.now() - chunkStart) / 1000 > CHUNK_SECONDS) {
      w += 1;
      break;
    }
  }

  report.meta.endedAt = new Date().toISOString();
  report.meta.endClock = (await api('GET', '/world/clock')).body;
  report.trackedCohort.sql =
    `SELECT id, name, stage, age_in_weeks, serve, forehand, backhand, volley, speed, stamina, strength,
            consistency, clutch, doubles, experience, fatigue, form, career_prize_money, season_prize_money
     FROM players WHERE id = ANY($1::text[]) ORDER BY id`;
  report.botSummaries = runtime.bots.map((bot) => ({
    managerId: bot.id,
    strategy: bot.strategy.id,
    ageTarget: bot.strategy.ageTarget,
    action: bot.strategy.action,
    rosterSize: bot.roster.filter((p) => p.stage !== 'retired').length,
    trackedPlayers: bot.roster.map((p) => p.id),
    claimsAttempted: bot.claims.length,
    claimsSucceeded: bot.claims.filter((c) => c.ok).length,
    singlesEntries: bot.entries.filter((e) => e.kind === 'singles').length,
    doublesEntries: bot.entries.filter((e) => e.kind === 'doubles').length,
    entryFailures: bot.entryFailures.length,
    noTournamentWeeks: bot.noTournamentWeeks.length,
    focusSets: bot.focusSets,
    practices: bot.practices,
    pairId: bot.pairId,
  }));

  const complete = report.state.weekIndex >= WEEK_COUNT;
  report.meta.partial = !complete;

  if (complete) {
    report.state.complete = true;
    report.finalCohort = {
      deltas: cohortDeltas(report.trackedCohort.weekly.map((wk) => wk.rows), report.trackedCohort.ids),
    };
    const evidenceClock = (await api('GET', '/world/clock')).body;
    report.evidence = await collectFinalEvidence(db, {
      ids,
      worldId: WORLD,
      currentAbs: absoWeek(evidenceClock.currentWeek),
    });
    report.strategyOutcomes = await collectStrategyOutcomes(db, ids);

    // ---- Derived anomaly checks ----
    // 1. Attribute/experience flatness (the old bug signature).
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
    // 2. Weekly entry cap violations.
    if (report.evidence.entryCap.statements[0].rows.length > 0) {
      report.anomalies.push({
        type: 'weekly-entry-cap-violation',
        rows: report.evidence.entryCap.statements[0].rows,
      });
    }
    // 3. 5xx.
    if (report.http.serverErrors.length > 0) {
      report.anomalies.push({ type: 'http-5xx', count: report.http.serverErrors.length, sample: report.http.serverErrors.slice(0, 10) });
    }
    // 4. Never-started / never-concluded. The never-started pile is the
    // per-week PRE-PRUNE count (stuckPruned records what the mitigation
    // removed; the product itself never does this).
    const neverStartedSeries = report.weeks.map((wk) => Number(wk.health?.never_started ?? 0));
    report.anomalies.push({
      type: 'tournament-never-started',
      peakPrePrune: Math.max(...neverStartedSeries),
      finalPrePrune: neverStartedSeries[neverStartedSeries.length - 1] ?? 0,
      totalPrunedByHarness: report.weeks.reduce((s, wk) => s + Number(wk.stuckPruned ?? 0), 0),
      stillOpenPastWeek: report.evidence.neverStarted.statements[0].rows.length,
      grouped: report.evidence.neverStarted.statements[1].rows,
      sample: report.evidence.neverStarted.statements[0].rows.slice(0, 10),
    });
    report.anomalies.push({
      type: 'tournament-never-concluded',
      count: report.evidence.neverConcluded.statements[0].rows.length,
      sample: report.evidence.neverConcluded.statements[0].rows.slice(0, 10),
    });
    // 5. World clock monotonicity across week snapshots.
    const clockSeries = report.weeks.map((wk) => absoWeek(wk.endClock));
    let worldClockRegressions = 0;
    for (let i = 1; i < clockSeries.length; i++) {
      if (clockSeries[i] < clockSeries[i - 1]) worldClockRegressions += 1;
    }
    report.anomalies.push({ type: 'world-clock-regressions', count: worldClockRegressions });
    // 6. Fatigue/form pins.
    const fatAll = report.evidence.fatigueForm.statements[0].rows[0];
    const formAll = report.evidence.fatigueForm.statements[1].rows[0];
    const fatTracked = report.evidence.fatigueForm.statements[2].rows[0];
    const formTracked = report.evidence.fatigueForm.statements[3].rows[0];
    report.anomalies.push({
      type: 'fatigue-pins',
      trackedAtZero: Number(fatTracked.at_zero),
      trackedAtHundred: Number(fatTracked.at_hundred),
      allAtZero: Number(fatAll.at_zero),
      allAtHundred: Number(fatAll.at_hundred),
    });
    report.anomalies.push({
      type: 'form-three-stall',
      trackedFormThree: Number(formTracked.form_three),
      allFormThree: Number(formAll.form_three),
    });
  } else {
    report.evidence = null;
    report.finalCohort = null;
    console.log(`[soak] partial chunk done at week ${report.state.weekIndex}/${WEEK_COUNT}; resume with SOAK_RESUME=1`);
  }

  db.release();
  await pool.end();
  saveCheckpoint();
  printSummary();
}

function printSummary() {
  const ruleRejections = Object.entries(report.http.ruleRejections).sort((a, b) => b[1] - a[1]);
  console.log('\n========== SOAK SUMMARY ==========');
  console.log(`World: ${report.meta.world} | weeks: ${report.weeks.length}/${report.meta.weeksPlanned} | complete: ${report.state?.complete === true}`);
  console.log(`HTTP requests: ${report.http.total} | 5xx: ${report.http.serverErrors.length} | unexpected 4xx: ${report.http.unexpected4xx.length} | concurrency 409: ${report.http.concurrencyConflicts}`);
  console.log(`Tracked players: ${report.trackedCohort.ids.length}`);
  if (report.finalCohort) {
    const flat = report.finalCohort.deltas.filter((d) => d.experienceRisingSkillsFlat);
    console.log(`Experience-rising/skills-flat cohort members: ${flat.length}`);
  }
  if (report.evidence) {
    console.log(`Entry-cap violations: ${report.evidence.entryCap.statements[0].rows.length}`);
    console.log(`Never-started tournaments (post-prune open): ${report.evidence.neverStarted.statements[0].rows.length}`);
    console.log(`Never-concluded tournaments: ${report.evidence.neverConcluded.statements[0].rows.length}`);
  }
  if (report.weeks.length > 0) {
    const ns = report.weeks.map((wk) => Number(wk.health?.never_started ?? 0));
    console.log(`Never-started pre-prune: peak ${Math.max(...ns)}, final ${ns[ns.length - 1]}, pruned total ${report.weeks.reduce((s, wk) => s + Number(wk.stuckPruned ?? 0), 0)}`);
  }
  for (const a of report.anomalies) console.log(`  [anomaly] ${a.type}: ${JSON.stringify(a).slice(0, 200)}`);
  console.log('Top rule rejections:');
  for (const [k, v] of ruleRejections.slice(0, 15)) console.log(`  ${k}: ${v}`);
  console.log(`Full report: ${REPORT_PATH}`);
}

main().catch((error) => {
  report.meta.endedAt = new Date().toISOString();
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.error('Soak failed:', error);
  process.exit(1);
});
