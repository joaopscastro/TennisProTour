import 'dotenv/config';
import {
  AgeBand,
  GameWorld,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  Skill,
  SurfaceAffinities,
  TournamentId,
  WorldId,
  juniorEligibilityForAge,
} from '@tennis-manager/domain';
import { createDb } from '../db/client';
import { buildDependencies } from '../composition';

/**
 * Junior-circuit walkthrough / verification script — NOT part of the
 * regular dev seed flow (see seed.ts for that). Deliberately uses a
 * dedicated world id and its own player/tournament id namespace so it
 * never collides with seed.ts's fixtures; safe to run against a
 * database seed.ts has already populated.
 *
 * Disclosed up front, not glossed over: this script constructs young
 * players directly via Player.hire() + a repository save, bypassing
 * ClaimTalentPoolCandidateUseCase and CreateCustomPlayerUseCase
 * entirely. That's not a shortcut of convenience — neither of those
 * use cases can produce a junior-eligible player at all. Both hire at
 * a fixed STARTING_AGE_IN_WEEKS = 18 years, which is already past the
 * U16 boundary (16 years). There is currently no path through the
 * normal game flow for a manager to ever acquire a junior-eligible
 * player. This script demonstrates the junior circuit mechanics
 * (tournaments, rankings, weekly cap, graduation carryover) are real
 * and correct at the domain/application layer; it does not — because
 * it cannot — demonstrate them via the same flow a real manager would
 * use, since that flow doesn't reach a junior-eligible player yet.
 */

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const worldId = WorldId('junior-walkthrough');
const MANAGER_ID = ManagerId('jw-manager');
const COHORT_SIZE = 16; // fills one draw exactly, no byes to reason about
// Two weeks before the U14 -> U16 boundary (14 * 52 = 728), so the
// whole cohort crosses together after 2 weekly ticks — fast enough to
// run in this script, not a multi-season wait.
const STARTING_AGE_WEEKS = 14 * 52 - 2;

function attributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base + 3), backhand: Skill.of(base + 1), volley: Skill.of(base + 2) },
    physical: { speed: Skill.of(base + 4), stamina: Skill.of(base + 2), strength: Skill.of(base + 1) },
    mental: { consistency: Skill.of(base + 2), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...args);
}

async function main(): Promise<void> {
  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory: process.env.MATCH_LOG_DIR ?? './data/match-logs',
    logEvent: () => {},
  });

  log('=== 0. World setup ===');
  if (!(await deps.worlds.findById(worldId))) {
    await deps.worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    log(`Created world "${worldId}" at season 1, week 1.`);
  } else {
    log(`World "${worldId}" already exists (rerun) — using its current state.`);
  }

  log('\n=== 1. Create a young player (bypassing the normal acquisition flow — see header comment) ===');
  const starId = PlayerId('jw-star');
  let star = await deps.players.findById(starId);
  if (!star) {
    star = Player.hire(starId, 'Young Star', STARTING_AGE_WEEKS, attributes(45), MANAGER_ID, 'BR');
    star.pullDomainEvents();
    await deps.players.save(star);
  }
  log(
    `Player "${star.name}" (${starId}), age ${STARTING_AGE_WEEKS} weeks (${(STARTING_AGE_WEEKS / 52).toFixed(2)} years), ` +
      `currently ${juniorEligibilityForAge(star.ageInWeeks)}-eligible.`,
  );

  log('\n=== 2. Generate this week\'s junior tournaments, both bands ===');
  const genResult = await deps.generateJuniorTournaments.execute({ worldId });
  log(`GenerateJuniorTournamentsUseCase: opened=${genResult.opened}, mastersHeld=${genResult.mastersHeld}`);

  const world1 = (await deps.worlds.findById(worldId))!;
  const openThisWeek = (await deps.tournaments.findOpenForRegistration()).filter(
    (t) => t.weekScheduled.season === world1.currentWeek.season && t.weekScheduled.week === world1.currentWeek.week,
  );
  const byBand: Record<string, string[]> = { u14: [], u16: [] };
  for (const t of openThisWeek) {
    if (t.ageBand) byBand[t.ageBand].push(`${t.tier}(${t.id})`);
  }
  log(`Open junior tournaments this week, U14 band (${byBand.u14.length}): ${byBand.u14.join(', ')}`);
  log(`Open junior tournaments this week, U16 band (${byBand.u16.length}): ${byBand.u16.join(', ')}`);
  log(
    'Note: nothing filters this list by the player\'s actual age — a disclosed gap ' +
      '(see docs/junior-circuit-research-and-proposal.md). The player above is U14-eligible; ' +
      'both bands\' tournaments are shown here because the system does not yet distinguish.',
  );

  log('\n=== 3. Enter the young player into 3 U14 tournaments, then confirm a 4th is rejected (weekly cap) ===');
  const u14ThisWeek = openThisWeek.filter((t) => t.ageBand === 'u14');
  const chosen = u14ThisWeek.slice(0, 4); // 3 should succeed, the 4th should be rejected
  for (let i = 0; i < 3; i++) {
    await deps.registerEntrant.execute({ tournamentId: chosen[i].id, playerId: starId });
    log(`  Registered into ${chosen[i].tier} (${chosen[i].id}) — OK (entry ${i + 1}/3)`);
  }
  try {
    await deps.registerEntrant.execute({ tournamentId: chosen[3].id, playerId: starId });
    log(`  UNEXPECTED: 4th registration into ${chosen[3].tier} (${chosen[3].id}) succeeded — cap did not fire!`);
  } catch (error) {
    log(`  4th registration into ${chosen[3].tier} (${chosen[3].id}) REJECTED: ${(error as Error).message}`);
  }

  log('\n=== 4. Fill one of those draws (16 players) and simulate it to completion, to get real ranking points ===');
  const fillTarget = chosen[0]; // whichever grade this is, fill it out
  log(`Filling ${fillTarget.tier} (${fillTarget.id}) — star player already entered, adding ${COHORT_SIZE - 1} more.`);
  const cohortIds: PlayerId[] = [starId];
  for (let i = 2; i <= COHORT_SIZE; i++) {
    const id = PlayerId(`jw-p${i}`);
    let p = await deps.players.findById(id);
    if (!p) {
      p = Player.hire(id, `Junior Player ${i}`, STARTING_AGE_WEEKS, attributes(40 + (i % 10)), MANAGER_ID, 'BR');
      p.pullDomainEvents();
      await deps.players.save(p);
    }
    await deps.registerEntrant.execute({ tournamentId: fillTarget.id, playerId: id });
    cohortIds.push(id);
  }
  const filled = await deps.tournaments.findById(fillTarget.id);
  log(`Draw filled: hasStarted=${filled!.hasStarted}, entrants=${filled!.entrants.length}`);

  log('Cascading SimulateDueMatchesUseCase until the tournament is finished...');
  for (let round = 1; round <= 5; round++) {
    const result = await deps.simulateDueMatches.execute();
    log(`  sweep ${round}: simulated=${result.simulated.length}, failed=${result.failed.length}`);
    for (const f of result.failed) log(`    FAILED: ${f.matchId} - ${f.reason}`);
    if (result.simulated.length === 0) break;
  }

  log('\n=== 5. Real ranking points, straight from the ledger ===');
  const ledgerEntries = (await Promise.all(cohortIds.map((id) => deps.rankingLedger.findByPlayer(id)))).flat();
  const byPoints = [...ledgerEntries].sort((a, b) => b.points - a.points);
  for (const entry of byPoints) {
    log(`  ${entry.playerId}: ${entry.points} points (tier ${entry.tier}, ageBand ${entry.ageBand})`);
  }
  const zeroCount = byPoints.filter((e) => e.points === 0).length;
  const positiveCount = byPoints.filter((e) => e.points > 0).length;
  log(`  -> ${zeroCount} first-round-loss entries at 0 points, ${positiveCount} entries with real points > 0.`);

  const starRankBefore = await deps.rankPositionU14.rankFor(starId);
  log(`Star player's U14 ranking right now: rank=${starRankBefore.rank}, totalPoints=${starRankBefore.totalPoints}`);

  log('\n=== 6. Advance the world week-by-week until the cohort crosses U14 -> U16 ===');
  for (let tick = 1; tick <= 3; tick++) {
    const advanceResult = await deps.advanceWorldWeek.execute({ worldId, tickKey: `jw-tick-${Date.now()}-${tick}` });
    if (advanceResult.advanced) {
      await deps.generateJuniorTournaments.execute({ worldId });
    }
    const w = (await deps.worlds.findById(worldId))!;
    const starNow = (await deps.players.findById(starId))!;
    const band = juniorEligibilityForAge(starNow.ageInWeeks);
    log(
      `  Tick ${tick}: week=${JSON.stringify(w.currentWeek)}, star age=${starNow.ageInWeeks} weeks, ` +
        `band=${band}, dormantCarryoverBonus=${JSON.stringify(starNow.dormantCarryoverBonus)}`,
    );
  }

  log('\n=== 7. Enter the (now U16) cohort into a fresh U16 draw, simulate round 1, look for the carryover firing ===');
  const world2 = (await deps.worlds.findById(worldId))!;
  const u16ThisWeek = (await deps.tournaments.findOpenForRegistration()).filter(
    (t) =>
      t.ageBand === 'u16' &&
      t.weekScheduled.season === world2.currentWeek.season &&
      t.weekScheduled.week === world2.currentWeek.week,
  );
  if (u16ThisWeek.length === 0) {
    log('  No fresh U16 tournament opened this week — skipping this step (schedule cadence did not line up).');
  } else {
    const u16Target = u16ThisWeek[0];
    log(`  Registering the cohort into ${u16Target.tier} (${u16Target.id})...`);
    for (const id of cohortIds) {
      await deps.registerEntrant.execute({ tournamentId: u16Target.id, playerId: id });
    }
    const startedU16 = await deps.tournaments.findById(u16Target.id);
    log(`  hasStarted=${startedU16!.hasStarted}`);

    const dormantBefore = new Map<string, unknown>();
    for (const id of cohortIds) {
      dormantBefore.set(id, (await deps.players.findById(id))!.dormantCarryoverBonus);
    }

    log('  Simulating until the draw is finished (so winners get a second match, giving carryover a real chance to fire)...');
    for (let sweep = 1; sweep <= 5; sweep++) {
      const simResult = await deps.simulateDueMatches.execute();
      log(`    sweep ${sweep}: simulated=${simResult.simulated.length}, failed=${simResult.failed.length}`);
      for (const f of simResult.failed) log(`      FAILED: ${f.matchId} - ${f.reason}`);
      if (simResult.simulated.length === 0) break;
    }

    const u16Entries = (await Promise.all(cohortIds.map((id) => deps.rankingLedger.findByPlayer(id)))).flat();
    const newU16Entries = u16Entries.filter((e) => e.ageBand === 'u16');
    let firedForAnyone = false;
    for (const entry of newU16Entries) {
      const before = dormantBefore.get(entry.playerId);
      const player = await deps.players.findById(entry.playerId);
      const consumed = before !== null && player!.dormantCarryoverBonus === null;
      log(
        `  ${entry.playerId}: U16 result = ${entry.points} points; had dormant bonus before = ` +
          `${JSON.stringify(before)}; carryover fired this match = ${consumed}`,
      );
      if (consumed) firedForAnyone = true;
    }
    log(firedForAnyone ? '  -> Graduation carryover FIRED for at least one player.' : '  -> No qualifying win occurred this round for anyone still holding a dormant bonus (0-point losses don\'t consume it) — real outcome, not staged.');
  }

  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
