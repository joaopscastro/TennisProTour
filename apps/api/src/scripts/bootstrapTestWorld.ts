import 'dotenv/config';
import { GameWeek, GameWorld, TournamentId, WorldId, addWeeks } from '@tennis-manager/domain';
import { createDb } from '../db/client';
import { buildDependencies, Dependencies } from '../composition';
import { resolveMatchLogDirectory } from '../matchLogDirectory';

/**
 * Alpha-activation bootstrap: turns an EMPTY world into one a tester can
 * actually play on the same day, without waiting a whole game-week for
 * the first tournaments to appear.
 *
 * Why a dedicated script instead of reusing `genesis-seed`/`seed`:
 *   - `genesisSeedFillOnlyPlayers` is NOT idempotent (fresh ids each run
 *     double the population) — deliberately not used here.
 *   - `GenerateJuniorTournamentsUseCase` always targets NEXT week and has
 *     NO idempotency guard — it is only called behind an explicit
 *     "no junior tournament already open for next week" check.
 *   - `seed.ts` writes `seed-m1`/`seed-*` rows; an alpha world must stay
 *     free of those, so nothing here touches it.
 *
 * Idempotent by construction: every phase either uses a use case that is
 * itself idempotent (`EnsureFillOnlyPopulationUseCase`,
 * `GenerateSeniorTournamentsUseCase`'s per-(week,tier) guard) or is gated
 * on a fixed-id / already-open check. Re-running generates 0 new fillers
 * and opens 0 new tournaments.
 *
 * The population guard runs TWICE (phases 1 and 6). Phase 1's run happens
 * before any slate exists, so it only applies the static floors — enough
 * for the phase-2 demo draw to fill. Phase 6 then runs AFTER the season's
 * slate has been opened, exactly mirroring the production handler's
 * generate-then-ensure order, so the demand pass sizes the pool for next
 * week's draws on the FIRST run and both calls are clean no-ops on a
 * re-run (without phase 6, a re-run's phase-1 call would see a slate it
 * never sized for and generate the demand shortfall then).
 *
 * RUN WITH THE WORKER STOPPED so the weekly tick can't race this script
 * (it force-starts due tournaments mid-run).
 *
 * Phases (see the printed summary):
 *   0. Ensure the GameWorld row exists.
 *   1. Top up the fill-only free-agent population to its per-band floors
 *      (idempotent — always runs).
 *   2. A fixed-id DEMO draw that AIRS immediately: a 16-draw futures
 *      scheduled THIS week, filled + seeded now, so round 1 plays on the
 *      very next tick and the tester can watch a replay same-day.
 *   3. An enterable CURRENT-week senior slate (futures/challenger/tour).
 *   4. The rest of the season's senior calendar (weeks current+1..52).
 *   5. The junior ladder for next week (guarded — see above).
 *   6. Demand-aware filler top-up for the slate just generated (see the
 *      idempotency note above).
 *
 * Run: npm run bootstrap -w apps/api
 */

/** Fixed id for the watchable demo draw — the guard that makes phase 2
 * re-runnable instead of blindly saving over an already-started bracket. */
export const DEMO_TOURNAMENT_ID = 'bootstrap-demo-futures';

export interface BootstrapWorldSummary {
  worldId: WorldId;
  worldCreated: boolean;
  week: GameWeek;
  /** Phases 1+6 — fill-only players generated this run (0 on a re-run). */
  fillersGenerated: number;
  /** Free agents now available to sign. */
  freeAgents: number;
  /** Phase 2 — the demo draw was opened this run. */
  demoOpened: boolean;
  /** Phase 2 — the demo draw was seeded this run (false if already done). */
  demoStarted: boolean;
  /** Phase 3 — current-week senior tournaments opened this run. */
  currentWeekSlateOpened: number;
  /** Phase 4 — future senior tournaments opened this run. */
  futureWeeksOpened: number;
  /** Phase 4 — how many future weeks were swept. */
  futureWeeks: number;
  /** Phase 5 — regular junior tournaments opened (0 if skipped/already present). */
  juniorOpened: number;
  /** Phase 5 — juniorMasters fields held this run. */
  juniorMastersHeld: number;
  /** Phase 5 — true when a next-week junior slate already existed. */
  juniorSkipped: boolean;
  /** Total tournaments now in the world (open + started). */
  totalTournaments: number;
}

function sameWeek(a: GameWeek, b: GameWeek): boolean {
  return a.season === b.season && a.week === b.week;
}

/**
 * The testable core: runs every bootstrap phase against already-built
 * `deps`, returning a summary. The CLI wrapper below owns the DB
 * connection and logging; keeping this pure of process concerns lets the
 * real-Postgres integration test drive it directly (see
 * bootstrapTestWorld.integration.test.ts).
 */
export async function bootstrapWorld(
  deps: Dependencies,
  worldId: WorldId,
  log: (message: string) => void,
): Promise<BootstrapWorldSummary> {
  // ---- Phase 0: world ----
  let world = await deps.worlds.findById(worldId);
  const worldCreated = world === null;
  if (!world) {
    world = GameWorld.create(worldId, { season: 1, week: 1 });
    await deps.worlds.save(world);
  }

  // ---- Phase 1: fill-only population floor (idempotent) ----
  const fill = await deps.ensureFillOnlyPopulation.execute({ worldId });
  log(`phase 1: generated ${fill.generated} fill-only player(s).`);

  // ---- Phase 2: the fixed-id demo draw that airs on the next tick ----
  const existingDemo = await deps.tournaments.findById(TournamentId(DEMO_TOURNAMENT_ID));
  let demoOpened = false;
  if (!existingDemo) {
    await deps.openRegistration.execute({
      tournamentId: TournamentId(DEMO_TOURNAMENT_ID),
      tier: 'futures',
      surface: 'clay',
      drawSize: 16,
      weekScheduled: world.currentWeek,
    });
    demoOpened = true;
  }
  // Guard on the aggregate, not just the row: only force-start when the
  // demo exists and its bracket is not already seeded. On a re-run the
  // tournament is started, so this `startDueTournaments` call is skipped
  // entirely — which also avoids force-starting the phase-3 slate.
  const demo = await deps.tournaments.findById(TournamentId(DEMO_TOURNAMENT_ID));
  let demoStarted = false;
  if (demo && !demo.hasStarted) {
    await deps.startDueTournaments.execute({ worldId });
    demoStarted = true;
  }
  log(
    `phase 2: demo "${DEMO_TOURNAMENT_ID}" ${demoOpened ? 'opened' : 'already existed'}; ` +
      `${demoStarted ? 'filled + seeded this run' : 'already seeded (left untouched)'}.`,
  );

  // ---- Phase 3: enterable current-week senior slate ----
  const currentSlate = await deps.generateSeniorTournaments.execute({ worldId, week: world.currentWeek });
  log(`phase 3: opened ${currentSlate.opened} current-week senior tournament(s).`);

  // ---- Phase 4: the rest of the season's senior calendar ----
  const startWeek = world.currentWeek.week;
  let futureWeeksOpened = 0;
  let futureWeeks = 0;
  for (let week = startWeek + 1; week <= 52; week++) {
    const result = await deps.generateSeniorTournaments.execute({
      worldId,
      week: { season: world.currentWeek.season, week },
    });
    futureWeeksOpened += result.opened;
    futureWeeks += 1;
  }
  log(`phase 4: opened ${futureWeeksOpened} future senior tournament(s) across ${futureWeeks} week(s).`);

  // ---- Phase 5: junior ladder (guarded — the use case is not idempotent) ----
  const nextWeek = addWeeks(world.currentWeek, 1);
  const open = await deps.tournaments.findOpenForRegistration();
  const juniorAlreadyNextWeek = open.some(
    (t) => t.ageBand !== null && sameWeek(t.weekScheduled, nextWeek),
  );
  let juniorOpened = 0;
  let juniorMastersHeld = 0;
  if (juniorAlreadyNextWeek) {
    log('phase 5: next-week junior slate already present — skipped.');
  } else {
    const junior = await deps.generateJuniorTournaments.execute({ worldId });
    juniorOpened = junior.opened;
    juniorMastersHeld = junior.mastersHeld;
    log(`phase 5: opened ${juniorOpened} junior tournament(s); ${juniorMastersHeld} juniorMasters field(s) held.`);
  }

  // ---- Phase 6: demand-aware filler sizing (after the slate exists) ----
  // The weekly handler generates first, then sizes the pool for the slate
  // it just opened; bootstrap mirrors that here. Phase 1 already applied
  // the static floors (the demo draw needed them before any slate
  // existed), so this second call is what makes the whole script
  // re-runnable: on the first run it reaches the demand target; on a
  // re-run both calls are no-ops.
  const demandFill = await deps.ensureFillOnlyPopulation.execute({ worldId });
  log(`phase 6: demand-aware filler top-up generated ${demandFill.generated} player(s).`);

  const [openCount, startedCount] = [
    (await deps.tournaments.findOpenForRegistration()).length,
    (await deps.tournaments.findStarted()).length,
  ];
  const freeAgents = (await deps.players.findFreeAgents()).length;

  return {
    worldId,
    worldCreated,
    week: world.currentWeek,
    fillersGenerated: fill.generated + demandFill.generated,
    freeAgents,
    demoOpened,
    demoStarted,
    currentWeekSlateOpened: currentSlate.opened,
    futureWeeksOpened,
    futureWeeks,
    juniorOpened,
    juniorMastersHeld,
    juniorSkipped: juniorAlreadyNextWeek,
    totalTournaments: openCount + startedCount,
  };
}

/** Prints the human-readable summary the runbook/operator reads. */
export function formatBootstrapSummary(summary: BootstrapWorldSummary): string {
  const lines = [
    '',
    `Bootstrap complete for world "${summary.worldId}" (S${summary.week.season}W${summary.week.week}).`,
    `  world created:            ${summary.worldCreated ? 'yes' : 'no (already existed)'}`,
    `  fillers generated:        ${summary.fillersGenerated}`,
    `  free agents available:    ${summary.freeAgents}`,
    `  demo draw opened/seeded:  ${summary.demoOpened ? 'yes' : 'no'} / ${summary.demoStarted ? 'yes' : 'no'}`,
    `  current-week slate opened:${summary.currentWeekSlateOpened}`,
    `  future weeks opened:      ${summary.futureWeeksOpened} (across ${summary.futureWeeks} week(s))`,
    `  junior opened:            ${summary.juniorSkipped ? 'skipped (already present)' : summary.juniorOpened}`,
    `  juniorMasters held:       ${summary.juniorMastersHeld}`,
    `  tournaments now:          ${summary.totalTournaments}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Detects "run directly as a script" without breaking when the test suite
 * imports `bootstrapWorld` from this module (vitest transforms to ESM,
 * where `require` is not defined — `typeof` keeps that safe).
 */
const isDirectRun = typeof require !== 'undefined' && require.main === module;

if (isDirectRun) {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';

  async function main(): Promise<void> {
    const db = createDb(connectionString);
    const deps = buildDependencies({
      db,
      matchLogDirectory: resolveMatchLogDirectory(),
      // eslint-disable-next-line no-console
      logEvent: (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
    });
    const worldId = WorldId(process.env.WORLD_ID ?? 'main');
    // eslint-disable-next-line no-console
    console.log('Bootstrapping a testable world (worker must be STOPPED)...');
    const summary = await bootstrapWorld(deps, worldId, (message) => {
      // eslint-disable-next-line no-console
      console.log(message);
    });
    // eslint-disable-next-line no-console
    console.log(formatBootstrapSummary(summary));
    process.exit(0);
  }

  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
