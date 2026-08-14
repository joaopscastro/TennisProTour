#!/usr/bin/env node
/**
 * Bot-manager playtest harness.
 *
 * Simulates a bunch of real managers playing the game against the RUNNING
 * API, the same way the web app does (HTTP only, `x-dev-manager-id` header
 * in dev auth mode). Every request's outcome is recorded; rule rejections
 * are classified separately from genuine anomalies (5xx, unexpected 4xx,
 * "insufficient XP" after funding, senior players with no tournament to
 * enter, etc). Outputs a JSON report and a console summary.
 *
 * Managers earn XP only from match results, so there is no XP-credit HTTP
 * endpoint — this script funds each bot's XP wallet directly (one row in
 * manager_progression, same table the game reads). Claiming still goes
 * through the real HTTP claim route.
 *
 * Usage:
 *   node apps/api/scripts/playtest.mjs
 *   BOT_COUNT=40 node apps/api/scripts/playtest.mjs
 *   OBSERVE_MINUTES=5 node apps/api/scripts/playtest.mjs   # poll simulation after actions
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const API = process.env.API_BASE ?? 'http://localhost:3000';
const BOT_COUNT = Number(process.env.BOT_COUNT ?? 100);
const BOT_PREFIX = process.env.BOT_PREFIX ?? 'bot';
const XP_PER_BOT = Number(process.env.BOT_XP ?? 100_000);
const OBSERVE_MINUTES = Number(process.env.OBSERVE_MINUTES ?? 0);
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const REPORT_PATH = process.env.PLAYTEST_REPORT ?? 'playtest-report.json';

const RATE_PER_SEC = 4.5; // stay under the API's 300/min per-IP limit
const U16_MAX_WEEKS = 16 * 52;

const report = {
  meta: { api: API, botCount: BOT_COUNT, runAt: new Date().toISOString(), worldClock: null },
  pools: { total: 0, u16: 0, senior: 0 },
  funding: 0,
  claims: { attempted: 0, succeeded: 0, failed: [] },
  perBot: [],
  rulesFired: {},
  serverErrors: [],
  unexpected4xx: [],
  anomalies: [],
  circuits: { juniorOpen: 0, seniorOpen: 0 },
  observe: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Global token bucket so concurrent bots never trip the API rate limiter. */
let nextSlot = 0;
function acquireSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 1000 / RATE_PER_SEC;
  return sleep(slot - now);
}

async function api(method, path, body, managerId) {
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
      try { json = await res.json(); } catch { /* non-JSON body */ }
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return { status: res.status, ok: res.ok, body: json };
    } catch (e) {
      await sleep(800);
    }
  }
  return { status: 0, ok: false, body: { error: 'network failure after retries' } };
}

function noteRule(ruleKey) {
  report.rulesFired[ruleKey] = (report.rulesFired[ruleKey] ?? 0) + 1;
}

/** Classify a non-2xx response. Returns true if it's an expected game rule. */
function classify(botId, step, res, extra = {}) {
  if (res.status >= 500 || res.status === 0) {
    report.serverErrors.push({ botId, step, status: res.status, body: res.body, ...extra });
    return false;
  }
  const message = res.body?.error ?? '';
  const KNOWN_RULES = [
    'insufficient XP', 'roster is full', 'at capacity', 'already', 'age', 'cap',
    'must not have an ageBand', 'does not support', 'not eligible', 'not found in your roster',
    'week', 'registered', 'too old', 'entry', 'slot', 'claim', 'pair',
  ];
  if (res.status === 409 || res.status === 400) {
    const isRule = message ? KNOWN_RULES.some((k) => message.toLowerCase().includes(k.toLowerCase())) : true;
    if (isRule) {
      noteRule(message);
      if (message.toLowerCase().includes('insufficient xp')) {
        report.anomalies.push({ botId, step, type: 'insufficient-xp-after-funding', detail: message });
      }
      return true;
    }
  }
  report.unexpected4xx.push({ botId, step, status: res.status, body: res.body, ...extra });
  return false;
}

async function main() {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  const db = await pool.connect();

  // ---- World clock + open-tournament inventory (circuit availability) ----
  const clock = await api('GET', '/world/clock');
  report.meta.worldClock = clock.body;
  const openList = await api('GET', '/tournaments?status=open');
  if (openList.ok && Array.isArray(openList.body)) {
    report.circuits.juniorOpen = openList.body.filter((t) => t.ageBand !== null).length;
    report.circuits.seniorOpen = openList.body.filter((t) => t.ageBand === null).length;
  }

  // ---- Talent pool: bucket by age band for a spread across all ages ----
  const poolRes = await api('GET', '/talent-pool');
  const agents = poolRes.ok ? poolRes.body : [];
  report.pools.total = agents.length;
  const u16 = agents.filter((p) => p.ageInWeeks <= U16_MAX_WEEKS);
  const senior = agents.filter((p) => p.ageInWeeks > U16_MAX_WEEKS);
  report.pools.u16 = u16.length;
  report.pools.senior = senior.length;

  // ---- Fund every bot's XP wallet directly ----
  const botIds = Array.from({ length: BOT_COUNT }, (_, i) => `${BOT_PREFIX}-${i + 1}`);
  for (const id of botIds) {
    await db.query(
      `INSERT INTO manager_progression (manager_id, xp_balance, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (manager_id) DO UPDATE SET xp_balance = EXCLUDED.xp_balance, updated_at = now()`,
      [id, XP_PER_BOT],
    );
    report.funding++;
  }

  // Assign two free agents per bot: even-index bots get an u16 pair (young),
  // odd-index bots get a senior pair (older) — spans the whole age ladder.
  // Distinct indices, so no two bots ever race for the same free agent.
  const juniorBotCount = Math.min(BOT_COUNT, Math.floor(u16.length / 2));
  const claimPlan = botIds.map((id, i) => {
    if (i < juniorBotCount) {
      const base = i * 2;
      return [u16[base], u16[base + 1]];
    }
    const j = i - juniorBotCount;
    const base = j * 2;
    return [senior[base], senior[base + 1]];
  });

  console.log(`Funding ${BOT_COUNT} bot managers (${XP_PER_BOT} XP each)... done.`);
  console.log(
    `Pool: ${agents.length} free agents (${u16.length} u16, ${senior.length} senior). ` +
      `${juniorBotCount} bots get u16 pairs, ${BOT_COUNT - juniorBotCount} get senior pairs.`,
  );

  // ---- Per-bot gameplay, bounded concurrency ----
  const CONCURRENCY = Number(process.env.BOT_CONCURRENCY ?? 6);
  let cursor = 0;
  async function worker() {
    while (cursor < botIds.length) {
      const i = cursor++;
      const botId = botIds[i];
      const pair = claimPlan[i];
      await runBot(botId, pair, openList.body ?? [], clock.body?.currentWeek ?? { season: 1, week: 42 });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ---- Optional observe phase: watch simulation progress for a while ----
  if (OBSERVE_MINUTES > 0) {
    const startedBefore = (await api('GET', '/tournaments?status=started')).body?.length;
    const endAt = Date.now() + OBSERVE_MINUTES * 60_000;
    const samples = [];
    while (Date.now() < endAt) {
      await sleep(15_000);
      const started = await api('GET', '/tournaments?status=started');
      const clockNow = await api('GET', '/world/clock');
      samples.push({
        t: new Date().toISOString(),
        startedCount: started.ok ? started.body.length : null,
        week: clockNow.body?.currentWeek,
        day: clockNow.body?.currentDay,
      });
      console.log(`  observe: week=${clockNow.body?.currentWeek?.season}W${clockNow.body?.currentWeek?.week} day=${clockNow.body?.currentDay} started=${started.ok ? started.body.length : 'err'}`);
    }
    report.observe = { startedBefore, samples };
  }

  db.release();
  await pool.end();

  // ---- Write report + summary ----
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  printSummary();
}

async function runBot(botId, pair, openList, currentWeek) {
  const entry = { bot: botId, players: [], issues: [] };
  const rostered = [];

  // 1. Account + entitlement (creates the manager account on first call)
  const me = await api('GET', '/auth/me', undefined, botId);
  if (!me.ok) entry.issues.push({ step: 'auth/me', status: me.status, body: me.body });
  const ent = await api('GET', `/managers/${encodeURIComponent(botId)}/entitlement`, undefined, botId);
  if (!ent.ok) entry.issues.push({ step: 'entitlement', status: ent.status, body: ent.body });

  // 2. Claim two free agents (across ages)
  for (const agent of pair ?? []) {
    if (!agent) continue;
    report.claims.attempted++;
    const res = await api('POST', `/talent-pool/${encodeURIComponent(agent.id)}/claim`, { managerId: botId }, botId);
    if (res.ok) {
      report.claims.succeeded++;
      rostered.push(res.body);
      entry.players.push({ id: res.body.id, name: res.body.name, ageWeeks: res.body.ageInWeeks, stage: res.body.stage });
    } else {
      report.claims.failed.push({ botId, agentId: agent.id, status: res.status, error: res.body?.error });
      classify(botId, `claim:${agent.id}`, res);
    }
  }

  if (rostered.length === 0) {
    report.perBot.push(entry);
    return;
  }

  // 3. Train + practice each rostered player
  const focus = { kind: 'attribute', attribute: 'serve' };
  for (const p of rostered) {
    const train = await api('PUT', `/players/${encodeURIComponent(p.id)}/training-focus`, { focus }, botId);
    if (!train.ok) classify(botId, `train:${p.id}`, train);
    const practice = await api('POST', `/players/${encodeURIComponent(p.id)}/practice`, undefined, botId);
    if (!practice.ok) classify(botId, `practice:${p.id}`, practice);
  }

  // 4. Singles entry: pick an age-eligible open tournament for each player.
  //    A player with NO eligible open tournament is itself a finding.
  const circuitsSeen = new Set();
  for (const p of rostered) {
    const list = await api('GET', `/tournaments?status=open&playerId=${encodeURIComponent(p.id)}`, undefined, botId);
    const candidates = (list.ok ? list.body : []).filter((t) => {
      if (t.ageEligible === false) return false;
      if (t.weeklyEntryCountThisWeek !== undefined && t.weeklyEntryCapThisWeek !== undefined && t.weeklyEntryCountThisWeek >= t.weeklyEntryCapThisWeek) return false;
      if (t.entrants.length >= t.drawSize) return false;
      return t.weekScheduled.season === currentWeek.season && t.weekScheduled.week === currentWeek.week;
    });
    const circuit = p.ageInWeeks > U16_MAX_WEEKS ? 'senior' : 'junior';
    circuitsSeen.add(circuit);
    const best = candidates.sort((a, b) => b.drawSize - a.drawSize)[0];
    if (!best) {
      if (circuit === 'senior') {
        report.anomalies.push({
          botId,
          playerId: p.id,
          ageWeeks: p.ageInWeeks,
          type: 'senior-no-open-tournament',
          detail: `Senior player has zero age-eligible open tournaments this week`,
        });
      }
      entry.issues.push({ step: `enter-singles:${p.id}`, type: 'no-eligible-open-tournament', circuit, openInCircuit: circuit === 'senior' ? report.circuits.seniorOpen : report.circuits.juniorOpen });
      continue;
    }
    const enter = await api('POST', `/tournaments/${encodeURIComponent(best.id)}/entrants`, { playerId: p.id }, botId);
    if (enter.ok) {
      entry.singlesEntered = entry.singlesEntered ?? [];
      entry.singlesEntered.push({ playerId: p.id, tournamentId: best.id, tier: best.tier, name: best.name });
    } else {
      classify(botId, `enter-singles:${p.id}->${best.id}`, enter);
    }
  }

  // 5. Doubles: pair the bot's two players, then register them into a
  //    same-week open doubles field when one is eligible.
  if (rostered.length >= 2) {
    const [a, b] = rostered;
    const pairRes = await api('POST', '/doubles-pairs', { playerA: a.id, playerB: b.id }, botId);
    if (pairRes.ok) {
      entry.pair = { id: pairRes.body.id, status: pairRes.body.status, chemistry: pairRes.body.chemistry };
    } else {
      classify(botId, `doubles-pair:${a.id}/${b.id}`, pairRes);
    }

    const bothJunior = a.ageInWeeks <= U16_MAX_WEEKS && b.ageInWeeks <= U16_MAX_WEEKS;
    const doublesList = await api('GET', `/tournaments?status=open&playerId=${encodeURIComponent(a.id)}`, undefined, botId);
    const dCandidates = (doublesList.ok ? doublesList.body : []).filter((t) => {
      if (bothJunior && t.ageBand === null) return false;
      if (t.ageEligible === false) return false;
      if (t.doublesDrawSize <= 0) return false;
      if (t.doublesEntrants.length >= t.doublesDrawSize) return false;
      return t.weekScheduled.season === currentWeek.season && t.weekScheduled.week === currentWeek.week;
    });
    const dBest = dCandidates.sort((x, y) => y.doublesDrawSize - x.doublesDrawSize)[0];
    if (dBest) {
      const first = await api('POST', `/tournaments/${encodeURIComponent(dBest.id)}/doubles-entrants`, { playerId: a.id }, botId);
      const second = await api('POST', `/tournaments/${encodeURIComponent(dBest.id)}/doubles-entrants`, { playerId: b.id }, botId);
      if (!first.ok) classify(botId, `doubles-entry:${a.id}->${dBest.id}`, first);
      if (!second.ok) classify(botId, `doubles-entry:${b.id}->${dBest.id}`, second);
      if (first.ok || second.ok) {
        entry.doublesEntered = entry.doublesEntered ?? [];
        entry.doublesEntered.push({ tournamentId: dBest.id, tier: dBest.tier, name: dBest.name, doublesDrawSize: dBest.doublesDrawSize });
      }
    } else {
      const circuitLabel = bothJunior ? 'junior' : 'senior';
      if (circuitLabel === 'senior') {
        report.anomalies.push({ botId, type: 'senior-no-open-doubles', detail: 'No open senior tournament with a doubles field this week' });
      }
      entry.issues.push({ step: 'doubles-entry', type: 'no-eligible-open-doubles', circuit: circuitLabel });
    }
  }

  // 6. Read-only sanity fetches
  const dash = await api('GET', `/managers/${encodeURIComponent(botId)}/roster-dashboard`, undefined, botId);
  if (!dash.ok) entry.issues.push({ step: 'roster-dashboard', status: dash.status, body: dash.body });
  if (rostered[0]) {
    const prof = await api('GET', `/players/${encodeURIComponent(rostered[0].id)}/profile`, undefined, botId);
    if (!prof.ok) entry.issues.push({ step: 'profile', status: prof.status, body: prof.body });
  }

  report.perBot.push(entry);
}

function printSummary() {
  const botsWithIssues = report.perBot.filter((b) => b.issues.length > 0).length;
  const botsEnteredSingles = report.perBot.filter((b) => (b.singlesEntered ?? []).length > 0).length;
  const botsEnteredDoubles = report.perBot.filter((b) => (b.doublesEntered ?? []).length > 0).length;
  const botsWithPairs = report.perBot.filter((b) => b.pair).length;

  console.log('\n========== PLAYTEST SUMMARY ==========');
  console.log(`Bots: ${BOT_COUNT} | Claims: ${report.claims.succeeded}/${report.claims.attempted} succeeded`);
  console.log(`Pairs formed: ${botsWithPairs} | Entered singles: ${botsEnteredSingles} | Entered doubles: ${botsEnteredDoubles}`);
  console.log(`Bots with issues: ${botsWithIssues}`);
  console.log(`Server errors: ${report.serverErrors.length}`);
  console.log(`Unexpected 4xx: ${report.unexpected4xx.length}`);
  console.log(`Anomalies: ${report.anomalies.length}`);
  for (const a of report.anomalies.slice(0, 20)) {
    console.log(`  [anomaly] ${a.type}: ${a.detail ?? ''} (${a.botId})`);
  }
  console.log('Rule rejections seen:');
  for (const [k, v] of Object.entries(report.rulesFired).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('Server errors:');
  for (const e of report.serverErrors.slice(0, 10)) {
    console.log(`  ${e.botId} ${e.step} -> ${e.status} ${JSON.stringify(e.body)}`);
  }
  console.log('Unexpected 4xx:');
  for (const e of report.unexpected4xx.slice(0, 10)) {
    console.log(`  ${e.botId} ${e.step} -> ${e.status} ${JSON.stringify(e.body)}`);
  }
  console.log(`\nFull report: ${REPORT_PATH}`);
}

main().catch((e) => {
  console.error('Playtest failed:', e);
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  process.exit(1);
});
