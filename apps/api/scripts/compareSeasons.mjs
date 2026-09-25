#!/usr/bin/env node
/**
 * Diffs an agent-played-season `report.json` against the bot-soak
 * `soak-report.json` and emits `compare.json`.
 *
 * The two reports come from the same world-tick pipeline, the same
 * evidence collectors (`lib/soakEvidence.mjs`) and the same HTTP loop —
 * they differ only in who makes the weekly decisions (LLM agents vs.
 * scripted bot strategies) and in run length. This tool puts the
 * comparable health metrics side by side so the differences are
 * inspectable rather than asserted.
 *
 * Usage:
 *   node apps/api/scripts/compareSeasons.mjs \
 *     --agent runs/<runId>/report.json \
 *     --soak soak-report.json \
 *     --out runs/<runId>/compare.json
 *
 * Defaults: the newest `runs/<runId>/report.json`, `soak-report.json` at
 * the repo root, and `<agent dir>/compare.json`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const RUNS_ROOT = join(REPO_ROOT, 'runs');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function newestAgentReport() {
  if (!existsSync(RUNS_ROOT)) return null;
  const runs = readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(RUNS_ROOT, e.name, 'report.json'))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, at: statSync(file).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return runs[0]?.file ?? null;
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function metric(name, agent, soak, note = null) {
  const a = numeric(agent);
  const s = numeric(soak);
  if (a === null && s === null) {
    return { metric: name, agent: agent ?? null, soak: soak ?? null, delta: null, note };
  }
  return { metric: name, agent: a, soak: s, delta: a !== null && s !== null ? Number((a - s).toFixed(3)) : null, note };
}

function countEvidenceRows(report, category, statementIndex = 0) {
  const statements = report?.evidence?.[category]?.statements;
  if (!Array.isArray(statements)) return null;
  const rows = statements[statementIndex]?.rows;
  return Array.isArray(rows) ? rows.length : null;
}

function evidenceRow(report, category, statementIndex = 0) {
  const statements = report?.evidence?.[category]?.statements;
  if (!Array.isArray(statements)) return null;
  const rows = statements[statementIndex]?.rows;
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function anomalyOf(report, type) {
  return (report?.anomalies ?? []).find((a) => a.type === type) ?? null;
}

function weekDurations(report) {
  return (report?.weeks ?? []).map((week) => {
    if (week.timingsMs) {
      return Object.values(week.timingsMs).reduce((sum, v) => sum + Number(v ?? 0), 0) / 1000;
    }
    return Number(week.durationSeconds ?? 0);
  });
}

function seriesStats(series) {
  if (!Array.isArray(series) || series.length === 0) return { n: 0, sum: 0, avg: 0, max: 0, last: 0 };
  const sum = series.reduce((s, v) => s + Number(v ?? 0), 0);
  return {
    n: series.length,
    sum: Number(sum.toFixed(1)),
    avg: Number((sum / series.length).toFixed(2)),
    max: Number(Math.max(...series).toFixed(1)),
    last: Number(series[series.length - 1]?.toFixed?.(1) ?? series[series.length - 1] ?? 0),
  };
}

function neverStartedSeries(report) {
  return (report?.weeks ?? []).map((week) => Number(week.health?.never_started ?? 0));
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const agentFile = resolve(REPO_ROOT, String(flags.agent ?? newestAgentReport() ?? ''));
  const soakFile = resolve(REPO_ROOT, String(flags.soak ?? 'soak-report.json'));
  if (!existsSync(agentFile)) {
    console.error(`Agent report not found: ${agentFile}\nPass --agent <runs/<runId>/report.json>`);
    process.exit(2);
  }
  if (!existsSync(soakFile)) {
    console.error(`Soak report not found: ${soakFile}\nPass --soak <soak-report.json>`);
    process.exit(2);
  }
  const agent = readJson(agentFile);
  const soak = readJson(soakFile);
  const outFile = resolve(REPO_ROOT, String(flags.out ?? join(dirname(agentFile), 'compare.json')));

  const agentDurations = weekDurations(agent);
  const soakDurations = weekDurations(soak);
  const agentTickCounts = (agent.weeks ?? []).map((w) => Number(w.tickCount ?? (w.tickSummary?.length ?? 0)));
  const soakTickCounts = (soak.weeks ?? []).map(() => 7);

  const metrics = [
    metric('weeks recorded', agent.weeks?.length, soak.weeks?.length),
    metric('http requests', agent.http?.total, soak.http?.total),
    metric('http 5xx', agent.http?.serverErrors?.length, soak.http?.serverErrors?.length),
    metric('http unexpected 4xx', agent.http?.unexpected4xx?.length, soak.http?.unexpected4xx?.length),
    metric('http concurrency 409', agent.http?.concurrencyConflicts, soak.http?.concurrencyConflicts),
    metric('tick count total', agentTickCounts.reduce((s, v) => s + v, 0), soakTickCounts.reduce((s, v) => s + v, 0)),
    metric('week duration avg (s)', seriesStats(agentDurations).avg, seriesStats(soakDurations).avg),
    metric('week duration max (s)', seriesStats(agentDurations).max, seriesStats(soakDurations).max),
    metric('never-started peak (pre-prune)', Math.max(0, ...neverStartedSeries(agent)), Math.max(0, ...neverStartedSeries(soak))),
    metric('never-started final (pre-prune)', neverStartedSeries(agent).at(-1) ?? 0, neverStartedSeries(soak).at(-1) ?? 0),
    metric('entry-cap violations (final)', countEvidenceRows(agent, 'entryCap'), countEvidenceRows(soak, 'entryCap')),
    metric('never-started still open (final)', countEvidenceRows(agent, 'neverStarted'), countEvidenceRows(soak, 'neverStarted')),
    metric('never-concluded (final)', countEvidenceRows(agent, 'neverConcluded'), countEvidenceRows(soak, 'neverConcluded')),
    metric('underfilled started draws (final)', countEvidenceRows(agent, 'underfilled'), countEvidenceRows(soak, 'underfilled')),
    metric('singles titles (final)', evidenceRow(agent, 'titlesAndLedger', 0)?.singles_titles, evidenceRow(soak, 'titlesAndLedger', 0)?.singles_titles),
    metric('doubles titles (final)', evidenceRow(agent, 'titlesAndLedger', 1)?.doubles_titles, evidenceRow(soak, 'titlesAndLedger', 1)?.doubles_titles),
    metric('ledger rows (final)', evidenceRow(agent, 'titlesAndLedger', 2)?.ledger_rows, evidenceRow(soak, 'titlesAndLedger', 2)?.ledger_rows),
    metric('negative ledger points (final)', evidenceRow(agent, 'titlesAndLedger', 2)?.negative_points, evidenceRow(soak, 'titlesAndLedger', 2)?.negative_points),
    metric('player state out-of-range (final)', evidenceRow(agent, 'playerStateSanity', 0)?.out_of_range, evidenceRow(soak, 'playerStateSanity', 0)?.out_of_range),
    metric('retired-but-managed (final)', evidenceRow(agent, 'playerStateSanity', 1)?.retired_but_managed, evidenceRow(soak, 'playerStateSanity', 1)?.retired_but_managed),
    metric('economy total XP (final)', evidenceRow(agent, 'economy', 0)?.total_xp, evidenceRow(soak, 'economy', 0)?.total_xp),
    metric('economy total career prize (final)', evidenceRow(agent, 'economy', 0)?.total_career_prize, evidenceRow(soak, 'economy', 0)?.total_career_prize),
    metric('economy total experience (final)', evidenceRow(agent, 'economy', 0)?.total_experience, evidenceRow(soak, 'economy', 0)?.total_experience),
    metric('economy total ladder (final)', evidenceRow(agent, 'economy', 0)?.total_ladder, evidenceRow(soak, 'economy', 0)?.total_ladder),
    metric(
      'cohort experience-rising/skills-flat',
      (agent.finalCohort?.deltas ?? []).filter((d) => d.experienceRisingSkillsFlat).length,
      (soak.finalCohort?.deltas ?? []).filter((d) => d.experienceRisingSkillsFlat).length,
    ),
  ];

  const anomalyTypes = new Set([
    ...(agent.anomalies ?? []).map((a) => a.type),
    ...(soak.anomalies ?? []).map((a) => a.type),
  ]);
  const anomalies = [...anomalyTypes].sort().map((type) => ({
    type,
    agent: anomalyOf(agent, type),
    soak: anomalyOf(soak, type),
  }));

  const compare = {
    generatedAt: new Date().toISOString(),
    agentReport: agentFile,
    soakReport: soakFile,
    agentMeta: { runId: agent.meta?.runId ?? null, weeksPlanned: agent.meta?.weeksPlanned ?? null, complete: agent.meta?.complete === true, endClock: agent.meta?.endClock?.currentWeek ?? null },
    soakMeta: { weeksPlanned: soak.meta?.weeksPlanned ?? null, complete: soak.meta?.partial === false, endClock: soak.meta?.endClock?.currentWeek ?? null },
    metrics,
    anomalies,
    ruleRejections: {
      agentTop: Object.entries(agent.http?.ruleRejections ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12),
      soakTop: Object.entries(soak.http?.ruleRejections ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12),
    },
    managerStats: agent.managerStats ?? null,
  };
  writeFileSync(outFile, JSON.stringify(compare, null, 2));

  console.log('========== SEASON COMPARE ==========');
  console.log(`agent: ${agentFile}`);
  console.log(`soak:  ${soakFile}`);
  console.log(`out:   ${outFile}\n`);
  const width = Math.max(...metrics.map((m) => m.metric.length)) + 2;
  console.log(`${'metric'.padEnd(width)}${'agent'.padStart(12)}${'soak'.padStart(12)}${'delta'.padStart(12)}`);
  for (const m of metrics) {
    console.log(
      `${m.metric.padEnd(width)}${String(m.agent ?? '—').padStart(12)}${String(m.soak ?? '—').padStart(12)}${String(m.delta ?? '—').padStart(12)}`,
    );
  }
  console.log('\nAnomalies present in either report:');
  for (const a of anomalies) {
    const inAgent = a.agent ? 'agent' : '';
    const inSoak = a.soak ? 'soak' : '';
    console.log(`  ${a.type} [${[inAgent, inSoak].filter(Boolean).join(', ')}]`);
  }
}

main();
