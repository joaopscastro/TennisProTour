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

// ---- Database helpers ----
async function q(db, sql, params = []) {
  const res = await db.query(sql, params);
  return res.rows;
}
const evidence = (claim, statements) => ({ claim, statements });

function absoWeek(w) {
  return w.season * 52 + w.week;
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

// ---- Evidence ----
async function snapshotTracked(db) {
  const ids = [...runtime.trackedIds];
  if (ids.length === 0) return [];
  const rows = await q(
    db,
    `SELECT id, name, stage, age_in_weeks, serve, forehand, backhand, volley, speed, stamina, strength,
            consistency, clutch, doubles, experience, fatigue, form, career_prize_money, season_prize_money
     FROM players WHERE id = ANY($1::text[]) ORDER BY id`,
    [ids],
  );
  return rows;
}

/** Per-week tournament-health counters, captured BEFORE any prune. */
async function weeklyHealth(db, currentAbs) {
  const rows = await q(
    db,
    `SELECT
       (SELECT count(*) FROM tournaments WHERE has_started = false
         AND (season_scheduled * 52 + week_scheduled) < $1) AS never_started,
       (SELECT count(*) FROM tournaments WHERE has_started = true) AS started,
       (SELECT count(*) FROM tournament_matches) AS matches,
       (SELECT count(*) FROM tournaments WHERE has_started = false) AS open`,
    [currentAbs],
  );
  return rows[0];
}

/**
 * Deletes only never-started, zero-entrant open tournaments more than 3 weeks
 * past their week. See PRUNE_STUCK's doc comment.
 */
async function pruneStuckTournaments(db, currentAbs) {
  const rows = await q(
    db,
    `DELETE FROM tournaments t
     WHERE t.has_started = false
       AND (t.season_scheduled * 52 + t.week_scheduled) < $1
       AND NOT EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM weekly_entry_claims c WHERE c.tournament_id = t.id)
     RETURNING t.id`,
    [currentAbs],
  );
  return rows.length;
}

/**
 * Bootstrap normalization (disclosed harness step): `bootstrapTestWorld`'s
 * phase 4 pre-opens the WHOLE remaining season's senior calendar (~259 open
 * tournaments), which makes every weekly rollover load them all. Production's
 * weekly generator only ever opens NEXT week, so steady state is ~30 open
 * tournaments, not ~290. On a fresh run this deletes the far-future
 * pre-opened senior tournaments (they were opened with zero entrants and are
 * re-created naturally by the weekly generator), restoring a production-like
 * open set. Never touches the current or next two weeks.
 */
async function normalizeBootstrap(db, currentAbs) {
  const rows = await q(
    db,
    `DELETE FROM tournaments t
     WHERE t.has_started = false
       AND (t.season_scheduled * 52 + t.week_scheduled) > $1
       AND NOT EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM weekly_entry_claims c WHERE c.tournament_id = t.id)
     RETURNING t.id`,
    [currentAbs + 2],
  );
  return rows.length;
}

/**
 * Match-row archival (HARNESS MITIGATION, disclosed): the product never
 * prunes `tournament_matches`, so every finished tournament is reloaded in
 * full by `findStarted()` on every day tick forever. For finished, old
 * tournaments with NO tracked-player entry, this keeps only the FINAL round
 * (so "never concluded" detection still works) and drops earlier rounds and
 * all doubles matches. It does not touch ranking_ledger, titles, entries or
 * XP, so economy/ranking/title evidence is unaffected; per-match evidence for
 * tracked players is preserved by the tracked-player exclusion.
 */
async function archiveOldMatchRows(db, currentAbs, trackedIds) {
  const ids = trackedIds.length > 0 ? trackedIds : ['__none__'];
  const archivableCte = `
    WITH finals AS (
      SELECT tournament_id, MAX(round_number) AS rn
      FROM tournament_matches WHERE draw = 'main' GROUP BY tournament_id
    ),
    archivable AS (
      SELECT t.id, f.rn
      FROM tournaments t JOIN finals f ON f.tournament_id = t.id
      WHERE t.has_started = true
        AND (t.season_scheduled * 52 + t.week_scheduled) < $1
        AND NOT EXISTS (SELECT 1 FROM tournament_matches fm
                        WHERE fm.tournament_id = t.id AND fm.draw = 'main'
                          AND fm.round_number = f.rn AND fm.winner_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM tournament_entries e
                        WHERE e.tournament_id = t.id AND e.player_id = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM tournament_doubles_entrants de
                        WHERE de.tournament_id = t.id AND de.player_id = ANY($2::text[]))
    )`;
  const mainDeleted = await q(
    db,
    `${archivableCte}
     DELETE FROM tournament_matches tm
     USING archivable a
     WHERE tm.tournament_id = a.id AND tm.draw = 'main' AND tm.round_number < a.rn
     RETURNING tm.tournament_id`,
    [currentAbs - 3, ids],
  );
  const doublesDeleted = await q(
    db,
    `${archivableCte}
     DELETE FROM tournament_doubles_matches dm
     USING archivable a
     WHERE dm.tournament_id = a.id
     RETURNING dm.tournament_id`,
    [currentAbs - 3, ids],
  );
  return { mainDeleted: mainDeleted.length, doublesDeleted: doublesDeleted.length };
}

async function snapshotEconomy(db, botIdsArr) {
  const rows = await q(
    db,
    `SELECT
       (SELECT COALESCE(sum(xp_balance),0) FROM manager_progression)::float AS total_xp,
       (SELECT COALESCE(sum(career_prize_money),0) FROM players)::float AS total_career_prize,
       (SELECT COALESCE(sum(season_prize_money),0) FROM players)::float AS total_season_prize,
       (SELECT COALESCE(sum(experience),0) FROM players)::float AS total_experience,
       (SELECT COALESCE(sum(score),0) FROM manager_ladder)::float AS total_ladder`,
    [],
  );
  const perManagerXp = await q(
    db,
    `SELECT manager_id, xp_balance FROM manager_progression WHERE manager_id = ANY($1::text[]) ORDER BY manager_id`,
    [botIdsArr],
  );
  const perManagerLadder = await q(
    db,
    `SELECT manager_id, score FROM manager_ladder WHERE manager_id = ANY($1::text[]) ORDER BY manager_id`,
    [botIdsArr],
  );
  return { totals: rows[0], perManagerXp, perManagerLadder };
}

function cohortDeltas(weekly, ids) {
  if (weekly.length === 0) return [];
  const first = weekly[0];
  const last = weekly[weekly.length - 1];
  const firstById = new Map(first.map((r) => [r.id, r]));
  const lastById = new Map(last.map((r) => [r.id, r]));
  const skillCols = ['serve', 'forehand', 'backhand', 'volley', 'speed', 'stamina', 'strength', 'consistency', 'clutch', 'doubles'];
  return ids.map((id) => {
    const a = firstById.get(id);
    const b = lastById.get(id);
    if (!a || !b) return { id, present: false };
    const skillDelta = {};
    let skillsMoved = 0;
    for (const c of skillCols) {
      const d = Number(b[c]) - Number(a[c]);
      skillDelta[c] = Number(d.toFixed(3));
      if (Math.abs(d) > 0.01) skillsMoved += 1;
    }
    const expDelta = Number((Number(b.experience) - Number(a.experience)).toFixed(3));
    const ovr = (row) => {
      const vals = ['serve', 'forehand', 'backhand', 'volley', 'speed', 'stamina', 'strength', 'consistency', 'clutch'];
      return vals.reduce((s, c) => s + Number(row[c]), 0) / vals.length;
    };
    return {
      id,
      name: b.name,
      stageStart: a.stage,
      stageEnd: b.stage,
      experienceDelta: expDelta,
      overallDelta: Number((ovr(b) - ovr(a)).toFixed(3)),
      skillsMoved,
      skillDelta,
      // The exact old-bug signature: XP/experience accumulating while every
      // skill column stays flat.
      experienceRisingSkillsFlat: expDelta > 0.5 && skillsMoved === 0,
    };
  });
}

async function collectFinalEvidence(db, botIdsArr) {
  const ids = [...runtime.trackedIds];
  const clock = (await api('GET', '/world/clock')).body;
  const currentAbs = absoWeek(clock.currentWeek);
  const ev = {};

  ev.entryCap = evidence(
    'No tracked player exceeds the weekly entry cap (1 senior / 3 junior, singles+doubles deduped by tournament).',
    [{
      sql: `WITH combined AS (
              SELECT e.player_id, t.season_scheduled AS season, t.week_scheduled AS week,
                     (t.age_band IS NOT NULL) AS is_junior, t.id AS tournament_id
              FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
              UNION ALL
              SELECT de.player_id, t.season_scheduled, t.week_scheduled,
                     (t.age_band IS NOT NULL), t.id
              FROM tournament_doubles_entrants de JOIN tournaments t ON t.id = de.tournament_id
            )
            SELECT player_id, season, week, is_junior, count(DISTINCT tournament_id) AS entries
            FROM combined
            WHERE player_id = ANY($1::text[])
            GROUP BY player_id, season, week, is_junior
            HAVING count(DISTINCT tournament_id) > CASE WHEN is_junior THEN 3 ELSE 1 END
            ORDER BY player_id, season, week`,
      params: [ids],
      rows: await q(db, `WITH combined AS (
              SELECT e.player_id, t.season_scheduled AS season, t.week_scheduled AS week,
                     (t.age_band IS NOT NULL) AS is_junior, t.id AS tournament_id
              FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
              UNION ALL
              SELECT de.player_id, t.season_scheduled, t.week_scheduled,
                     (t.age_band IS NOT NULL), t.id
              FROM tournament_doubles_entrants de JOIN tournaments t ON t.id = de.tournament_id
            )
            SELECT player_id, season, week, is_junior, count(DISTINCT tournament_id) AS entries
            FROM combined
            WHERE player_id = ANY($1::text[])
            GROUP BY player_id, season, week, is_junior
            HAVING count(DISTINCT tournament_id) > CASE WHEN is_junior THEN 3 ELSE 1 END
            ORDER BY player_id, season, week`, [ids]),
    }],
  );

  ev.neverStarted = evidence(
    'No tournament remained open past its scheduled week (has_started = false with week_scheduled < current week).',
    [{
      sql: `SELECT id, name, tier, age_band, season_scheduled, week_scheduled
            FROM tournaments
            WHERE has_started = false AND (season_scheduled * 52 + week_scheduled) < $1
            ORDER BY season_scheduled, week_scheduled LIMIT 200`,
      params: [currentAbs],
      rows: await q(db, `SELECT id, name, tier, age_band, season_scheduled, week_scheduled
            FROM tournaments
            WHERE has_started = false AND (season_scheduled * 52 + week_scheduled) < $1
            ORDER BY season_scheduled, week_scheduled LIMIT 200`, [currentAbs]),
    },
    {
      sql: `SELECT tier, age_band, count(*) AS n,
                   count(*) FILTER (WHERE entrant_count = 0) AS zero_entrant
            FROM (
              SELECT t.id, t.tier, t.age_band,
                     (SELECT count(*) FROM tournament_entries e WHERE e.tournament_id = t.id) AS entrant_count
              FROM tournaments t
              WHERE t.has_started = false AND (t.season_scheduled * 52 + t.week_scheduled) < $1
            ) s
            GROUP BY tier, age_band ORDER BY n DESC`,
      params: [currentAbs],
      rows: await q(db, `SELECT tier, age_band, count(*) AS n,
                   count(*) FILTER (WHERE entrant_count = 0) AS zero_entrant
            FROM (
              SELECT t.id, t.tier, t.age_band,
                     (SELECT count(*) FROM tournament_entries e WHERE e.tournament_id = t.id) AS entrant_count
              FROM tournaments t
              WHERE t.has_started = false AND (t.season_scheduled * 52 + t.week_scheduled) < $1
            ) s
            GROUP BY tier, age_band ORDER BY n DESC`, [currentAbs]),
    }],
  );

  ev.neverConcluded = evidence(
    'Every started tournament at least 3 weeks past its scheduled week has a decided main draw.',
    [{
      sql: `WITH last_round AS (
              SELECT tournament_id, MAX(round_number) AS rn
              FROM tournament_matches WHERE draw = 'main' GROUP BY tournament_id
            )
            SELECT t.id, t.name, t.tier, t.age_band, t.season_scheduled, t.week_scheduled, lr.rn,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn) AS final_matches,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) AS final_undecided
            FROM tournaments t
            LEFT JOIN last_round lr ON lr.tournament_id = t.id
            WHERE t.has_started = true
              AND (t.season_scheduled * 52 + t.week_scheduled) < $1
              AND NOT EXISTS (SELECT 1 FROM titles ti WHERE ti.tournament_id = t.id)
              AND (lr.rn IS NULL OR (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) > 0)
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`,
      params: [currentAbs - 3],
      rows: await q(db, `WITH last_round AS (
              SELECT tournament_id, MAX(round_number) AS rn
              FROM tournament_matches WHERE draw = 'main' GROUP BY tournament_id
            )
            SELECT t.id, t.name, t.tier, t.age_band, t.season_scheduled, t.week_scheduled, lr.rn,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn) AS final_matches,
                   (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) AS final_undecided
            FROM tournaments t
            LEFT JOIN last_round lr ON lr.tournament_id = t.id
            WHERE t.has_started = true
              AND (t.season_scheduled * 52 + t.week_scheduled) < $1
              AND NOT EXISTS (SELECT 1 FROM titles ti WHERE ti.tournament_id = t.id)
              AND (lr.rn IS NULL OR (SELECT count(*) FROM tournament_matches m
                     WHERE m.tournament_id = t.id AND m.draw = 'main' AND m.round_number = lr.rn
                       AND m.winner_id IS NULL) > 0)
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`, [currentAbs - 3]),
    }],
  );

  ev.underfilled = evidence(
    'No started tournament has fewer entrants than its draw size.',
    [{
      sql: `SELECT t.id, t.name, t.tier, t.age_band, t.draw_size, count(e.player_id) AS entrants
            FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
            WHERE t.has_started = true
            GROUP BY t.id, t.name, t.tier, t.age_band, t.draw_size
            HAVING count(e.player_id) < t.draw_size
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`,
      params: [],
      rows: await q(db, `SELECT t.id, t.name, t.tier, t.age_band, t.draw_size, count(e.player_id) AS entrants
            FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
            WHERE t.has_started = true
            GROUP BY t.id, t.name, t.tier, t.age_band, t.draw_size
            HAVING count(e.player_id) < t.draw_size
            ORDER BY t.season_scheduled, t.week_scheduled LIMIT 200`, []),
    }],
  );

  ev.titlesAndLedger = evidence(
    'Titles and ranking-ledger rows exist and no ranking-ledger row has negative points.',
    [
      { sql: 'SELECT count(*) AS singles_titles FROM titles', params: [], rows: await q(db, 'SELECT count(*) AS singles_titles FROM titles') },
      { sql: 'SELECT count(*) AS doubles_titles FROM doubles_titles', params: [], rows: await q(db, 'SELECT count(*) AS doubles_titles FROM doubles_titles') },
      { sql: `SELECT count(*) AS ledger_rows,
                     count(*) FILTER (WHERE points < 0) AS negative_points,
                     count(*) FILTER (WHERE obligatory) AS obligatory_zeros,
                     COALESCE(min(points),0) AS min_points, COALESCE(max(points),0) AS max_points
              FROM ranking_ledger`, params: [], rows: await q(db, `SELECT count(*) AS ledger_rows,
                     count(*) FILTER (WHERE points < 0) AS negative_points,
                     count(*) FILTER (WHERE obligatory) AS obligatory_zeros,
                     COALESCE(min(points),0) AS min_points, COALESCE(max(points),0) AS max_points
              FROM ranking_ledger`) },
    ],
  );

  ev.worldClock = evidence('The soak world clock is monotonic and has a single applied tick key.', [
    {
      sql: 'SELECT id, season, week, current_day, last_applied_tick FROM game_worlds WHERE id = $1',
      params: [WORLD],
      rows: await q(db, 'SELECT id, season, week, current_day, last_applied_tick FROM game_worlds WHERE id = $1', [WORLD]),
    },
  ]);

  ev.playerStateSanity = evidence('No player has an out-of-range skill/fatigue/form/money value; no retired player is managed.', [
    {
      sql: `SELECT count(*) AS out_of_range FROM players
            WHERE age_in_weeks < 0 OR fatigue < 0 OR fatigue > 100 OR form < 0 OR form > 100
               OR serve < 0 OR serve > 100 OR forehand < 0 OR forehand > 100 OR backhand < 0 OR backhand > 100
               OR volley < 0 OR volley > 100 OR speed < 0 OR speed > 100 OR stamina < 0 OR stamina > 100
               OR strength < 0 OR strength > 100 OR consistency < 0 OR consistency > 100
               OR clutch < 0 OR clutch > 100 OR doubles < 0 OR doubles > 100
               OR experience < 0 OR career_prize_money < 0 OR season_prize_money < 0`,
      params: [],
      rows: await q(db, `SELECT count(*) AS out_of_range FROM players
            WHERE age_in_weeks < 0 OR fatigue < 0 OR fatigue > 100 OR form < 0 OR form > 100
               OR serve < 0 OR serve > 100 OR forehand < 0 OR forehand > 100 OR backhand < 0 OR backhand > 100
               OR volley < 0 OR volley > 100 OR speed < 0 OR speed > 100 OR stamina < 0 OR stamina > 100
               OR strength < 0 OR strength > 100 OR consistency < 0 OR consistency > 100
               OR clutch < 0 OR clutch > 100 OR doubles < 0 OR doubles > 100
               OR experience < 0 OR career_prize_money < 0 OR season_prize_money < 0`),
    },
    {
      sql: `SELECT count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NOT NULL) AS retired_but_managed,
                   count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NULL) AS retired_free_agents
            FROM players`,
      params: [],
      rows: await q(db, `SELECT count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NOT NULL) AS retired_but_managed,
                   count(*) FILTER (WHERE stage = 'retired' AND manager_id IS NULL) AS retired_free_agents
            FROM players`),
    },
  ]);

  ev.fatigueForm = evidence(
    'Fatigue/form distributions for ALL players (context) and for the TRACKED cohort (where a pin is a real signal, since idle fill-only players legitimately sit at fatigue 0).',
    [
      {
        sql: `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred
              FROM players`,
        params: [],
        rows: await q(db, `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred FROM players`),
      },
      {
        sql: `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three FROM players`,
        params: [],
        rows: await q(db, `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three FROM players`),
      },
      {
        sql: `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred
              FROM players WHERE id = ANY($1::text[])`,
        params: [ids],
        rows: await q(db, `SELECT min(fatigue) AS min_fatigue, max(fatigue) AS max_fatigue,
                     count(*) FILTER (WHERE fatigue = 0) AS at_zero,
                     count(*) FILTER (WHERE fatigue = 100) AS at_hundred
              FROM players WHERE id = ANY($1::text[])`, [ids]),
      },
      {
        sql: `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three
              FROM players WHERE id = ANY($1::text[])`,
        params: [ids],
        rows: await q(db, `SELECT min(form) AS min_form, max(form) AS max_form, count(*) FILTER (WHERE form = 3) AS form_three
              FROM players WHERE id = ANY($1::text[])`, [ids]),
      },
    ],
  );

  ev.economy = evidence('Economy totals across the soak.', [
    {
      sql: `SELECT
              (SELECT COALESCE(sum(xp_balance),0) FROM manager_progression)::float AS total_xp,
              (SELECT COALESCE(sum(career_prize_money),0) FROM players)::float AS total_career_prize,
              (SELECT COALESCE(sum(season_prize_money),0) FROM players)::float AS total_season_prize,
              (SELECT COALESCE(sum(experience),0) FROM players)::float AS total_experience,
              (SELECT COALESCE(sum(score),0) FROM manager_ladder)::float AS total_ladder`,
      params: [],
      rows: await q(db, `SELECT
              (SELECT COALESCE(sum(xp_balance),0) FROM manager_progression)::float AS total_xp,
              (SELECT COALESCE(sum(career_prize_money),0) FROM players)::float AS total_career_prize,
              (SELECT COALESCE(sum(season_prize_money),0) FROM players)::float AS total_season_prize,
              (SELECT COALESCE(sum(experience),0) FROM players)::float AS total_experience,
              (SELECT COALESCE(sum(score),0) FROM manager_ladder)::float AS total_ladder`),
    },
  ]);

  return ev;
}

async function collectStrategyOutcomes(db) {
  const ids = [...runtime.trackedIds];
  if (ids.length === 0) return null;
  const matchRecords = await q(
    db,
    `WITH sides AS (
       SELECT m.tournament_id, m.winner_id, m.entrant_a AS player_id
       FROM tournament_matches m WHERE m.winner_id IS NOT NULL
       UNION ALL
       SELECT m.tournament_id, m.winner_id, m.entrant_b
       FROM tournament_matches m WHERE m.winner_id IS NOT NULL
     )
     SELECT p.manager_id, t.tier, (t.age_band IS NOT NULL) AS is_junior,
            count(*) AS matches, count(*) FILTER (WHERE s.winner_id = s.player_id) AS wins
     FROM sides s JOIN players p ON p.id = s.player_id JOIN tournaments t ON t.id = s.tournament_id
     WHERE s.player_id = ANY($1::text[])
     GROUP BY p.manager_id, t.tier, (t.age_band IS NOT NULL)
     ORDER BY p.manager_id, t.tier`,
    [ids],
  );
  const entries = await q(
    db,
    `SELECT p.manager_id, t.tier, count(*) AS entries
     FROM tournament_entries e JOIN players p ON p.id = e.player_id JOIN tournaments t ON t.id = e.tournament_id
     WHERE e.player_id = ANY($1::text[])
     GROUP BY p.manager_id, t.tier ORDER BY p.manager_id, t.tier`,
    [ids],
  );
  const doublesEntries = await q(
    db,
    `SELECT p.manager_id, count(*) AS entries
     FROM tournament_doubles_entrants de JOIN players p ON p.id = de.player_id
     WHERE de.player_id = ANY($1::text[]) GROUP BY p.manager_id ORDER BY p.manager_id`,
    [ids],
  );
  const titles = await q(
    db,
    `SELECT p.manager_id, ti.tier, (ti.age_band IS NOT NULL) AS is_junior, count(*) AS titles
     FROM titles ti JOIN players p ON p.id = ti.player_id
     WHERE ti.player_id = ANY($1::text[]) GROUP BY p.manager_id, ti.tier, (ti.age_band IS NOT NULL)
     ORDER BY p.manager_id, ti.tier`,
    [ids],
  );
  const points = await q(
    db,
    `SELECT p.manager_id, rl.tier, COALESCE(sum(rl.points),0) AS points, count(*) AS results
     FROM ranking_ledger rl JOIN players p ON p.id = rl.player_id
     WHERE rl.player_id = ANY($1::text[]) GROUP BY p.manager_id, rl.tier ORDER BY p.manager_id, rl.tier`,
    [ids],
  );
  return {
    matchRecords: { sql: 'sides CTE over tournament_matches joined to players/tournaments', rows: matchRecords },
    entries: { sql: 'tournament_entries grouped by manager/tier', rows: entries },
    doublesEntries: { sql: 'tournament_doubles_entrants grouped by manager', rows: doublesEntries },
    titles: { sql: 'titles grouped by manager/tier', rows: titles },
    points: { sql: 'ranking_ledger grouped by manager/tier', rows: points },
  };
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
    const tracked = await snapshotTracked(db);
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
    report.evidence = await collectFinalEvidence(db, ids);
    report.strategyOutcomes = await collectStrategyOutcomes(db);

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
