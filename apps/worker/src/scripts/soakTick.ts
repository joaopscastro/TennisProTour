// Same explicit, cwd-independent .env loading as every other entry point
// (apps/api/src/index.ts, apps/worker/src/index.ts): resolve against
// __dirname so the script works no matter which directory invoked it.
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(__dirname, '../../../.env') });

import { WorldId } from '@tennis-manager/domain';
import { buildDependencies, createDb, Dependencies, resolveMatchLogDirectory } from '@tennis-manager/api';
import { AdvanceWorldJobData, makeAdvanceWorldHandler } from '../jobs/handlers';

/**
 * A synthetic, in-process world-tick driver for multi-season soak tests.
 *
 * WHY THIS EXISTS: the wall clock is unusable for a multi-season soak —
 * one game season is 364 real day-ticks, so a real-cadence run would take
 * months. This script calls the REAL `makeAdvanceWorldHandler` (the exact
 * function the BullMQ worker invokes) in a tight loop, with no Redis and no
 * waits, so the full day-tick pipeline — match sweep, qualifier promotion,
 * and every weekly system on the day-7->day-1 rollover — runs exactly as it
 * does in production. Nothing here re-implements or shortcuts that
 * pipeline; the only difference from the scheduler path is where the
 * synthetic tick key comes from.
 *
 * TICK KEYS: `makeAdvanceWorldHandler`'s idempotency guard lives in
 * `GameWorld` (`lastAppliedTick`), so every tick must carry a UNIQUE,
 * increasing key. The handler is passed `tickIntervalMs` from
 * `--tick-interval-ms` (default `null`), which the handler forwards to
 * the match sweep as the real-time length of ONE game day. `null` keeps
 * the production 24h fallback (the default for every existing caller);
 * a caller that compresses a whole game-week into real minutes passes
 * the compressed day length instead, so every match's staggered reveal
 * (`scheduled_start_at` + `reveal_seconds`) still lands INSIDE its own
 * game day — the H2 fix for the agent-season harness, where a 24h
 * fallback left results un-aired for real hours (many game weeks) and
 * the `current-matches` air gate then reported week-2 matches as the
 * "next" match at week 12. The tick key is NOT derived from the real
 * calendar — the caller supplies it. `driveTicks` therefore emits
 * `soak-d<startIndex + n>` and callers that spawn this script once per
 * game-week MUST pass a monotonically increasing `--start` (see
 * apps/api/scripts/soak.mjs): without it, each fresh process would
 * restart at `soak-d0` and every tick after the first spawn would be
 * silently refused as a duplicate.
 *
 * NEVER run this concurrently with the real worker on the same world —
 * both would advance the same `GameWorld` row (and fight over the tick
 * key). See the script's own CLI guard reminder below.
 */

export interface DriveTicksOptions {
  /** First synthetic tick index. Must be unique/increasing across every
   * process that drives the same world (see the module doc comment). */
  startIndex?: number;
  /** Real-time length of ONE game day, in ms, forwarded to the day tick's
   * match sweep so reveal windows tile the compressed day. `null`/omitted
   * keeps the production 24h cron fallback (see the module doc comment —
   * the H2 fix for the agent-season harness). Has NO effect on the tick
   * key when the caller supplies one (`driveTicks` always does). */
  tickIntervalMs?: number | null;
  /** Per-tick progress log. Omitted = silent. */
  log?: (message: string) => void;
}

export interface DrivenTickResult {
  tickKey: string;
  advanced: boolean;
  weekRolledOver: boolean;
  seasonRolledOver: boolean;
  matchesSimulated?: number;
  matchesFailed?: number;
  qualifiersPromoted?: number;
  mainDrawsSeeded?: number;
  /** Wall-clock ms this tick took (diagnostic only). */
  elapsedMs?: number;
}

/**
 * Drives `count` sequential real day-ticks against `worldId`, awaiting
 * each before starting the next.
 *
 * Args:
 *   deps: The composed application dependency graph (same object the
 *     BullMQ worker builds).
 *   worldId: The world to advance.
 *   count: How many day-ticks to apply.
 *   opts: Optional start index (for cross-process key uniqueness), the
 *     compressed day length in ms (`tickIntervalMs`, threaded into the
 *     match sweep's reveal windows), and a progress logger.
 *
 * Returns:
 *   One entry per tick, in order, with the handler's own result fields.
 *
 * Raises:
 *   Whatever the real handler raises — a failed tick aborts the loop
 *   rather than being swallowed, so the caller sees a non-zero exit.
 */
export async function driveTicks(
  deps: Dependencies,
  worldId: string | WorldId,
  count: number,
  opts: DriveTicksOptions = {},
): Promise<DrivenTickResult[]> {
  const startIndex = opts.startIndex ?? 0;
  const log = opts.log ?? (() => undefined);
  const handler = makeAdvanceWorldHandler(deps, opts.tickIntervalMs ?? null);
  const results: DrivenTickResult[] = [];

  for (let n = 0; n < count; n++) {
    const tickKey = `soak-d${startIndex + n}`;
    const data: AdvanceWorldJobData = { worldId, tickKey };
    const tickStart = Date.now();
    // The handler returns a union (the plain week result when the tick is a
    // no-op, the extended object when it advanced). This local shape reads
    // the optional match fields off either branch.
    const result = (await handler(data)) as {
      advanced: boolean;
      weekRolledOver: boolean;
      seasonRolledOver?: boolean;
      matchesSimulated?: number;
      matchesFailed?: number;
      qualifiersPromoted?: number;
      mainDrawsSeeded?: number;
    };
    const driven: DrivenTickResult = {
      tickKey,
      advanced: result.advanced,
      weekRolledOver: result.weekRolledOver,
      seasonRolledOver: result.seasonRolledOver ?? false,
      matchesSimulated: result.matchesSimulated,
      matchesFailed: result.matchesFailed,
      qualifiersPromoted: result.qualifiersPromoted,
      mainDrawsSeeded: result.mainDrawsSeeded,
    };
    driven.elapsedMs = Date.now() - tickStart;
    results.push(driven);
    log(
      `tick ${tickKey}: advanced=${driven.advanced} rollover=${driven.weekRolledOver}` +
        (driven.matchesSimulated !== undefined ? ` simulated=${driven.matchesSimulated}` : '') +
        (driven.matchesFailed ? ` failed=${driven.matchesFailed}` : '') +
        ` elapsedMs=${driven.elapsedMs}`,
    );
  }

  return results;
}

/**
 * Parses `--ticks N` / `--start N` / `--tick-interval-ms N` (all optional;
 * an unset `--start` means 0 and an unset `--tick-interval-ms` means
 * `null` — the production 24h fallback). Kept tiny and dependency-free so
 * it is trivially testable.
 */
export function parseArgs(argv: string[]): { ticks: number; startIndex: number; tickIntervalMs: number | null } {
  let ticks = 1;
  let startIndex = 0;
  let tickIntervalMs: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ticks' && argv[i + 1] !== undefined) {
      ticks = Number(argv[++i]);
    } else if (argv[i] === '--start' && argv[i + 1] !== undefined) {
      startIndex = Number(argv[++i]);
    } else if (argv[i] === '--tick-interval-ms' && argv[i + 1] !== undefined) {
      tickIntervalMs = Number(argv[++i]);
    }
  }
  if (!Number.isInteger(ticks) || ticks < 1) {
    throw new Error(`--ticks must be a positive integer, got "${ticks}"`);
  }
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error(`--start must be a non-negative integer, got "${startIndex}"`);
  }
  if (tickIntervalMs !== null && (!Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0)) {
    throw new Error(`--tick-interval-ms must be a positive number of milliseconds, got "${tickIntervalMs}"`);
  }
  return { ticks, startIndex, tickIntervalMs };
}

async function main(): Promise<void> {
  const { ticks, startIndex, tickIntervalMs } = parseArgs(process.argv.slice(2));
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
  const worldId = process.env.WORLD_ID ?? 'main';

  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory: resolveMatchLogDirectory(),
    // eslint-disable-next-line no-console
    logEvent: (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
  });

  // eslint-disable-next-line no-console
  console.log(
    `driving ${ticks} day-tick(s) for world "${worldId}" from index ${startIndex} (worker must be STOPPED)` +
      (tickIntervalMs !== null ? ` — compressed day window ${tickIntervalMs}ms` : ' — default 24h day window'),
  );
  const results = await driveTicks(deps, worldId, ticks, {
    startIndex,
    tickIntervalMs,
    // eslint-disable-next-line no-console
    log: (message) => console.log(message),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: 'soak ticks complete', worldId, startIndex, ticks, results }));
  process.exit(0);
}

/** `typeof require` guard keeps this importable from vitest transforms. */
const isDirectRun = typeof require !== 'undefined' && require.main === module;

if (isDirectRun) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
