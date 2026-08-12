import 'dotenv/config';
import {
  GameWorld,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  RandomSource,
  Skill,
  StandardAgingPolicy,
  StandardPlayerGenerationPolicy,
  SurfaceAffinities,
  TournamentId,
  WorldId,
  juniorEligibilityForAge,
} from '@tennis-manager/domain';
import { TALENT_POOL_AGE_RANGE } from '@tennis-manager/application';
import { createDb } from '../db/client';
import { buildDependencies } from '../composition';

/**
 * Junior-circuit walkthrough / verification script — NOT part of the
 * regular dev seed flow (see seed.ts for that). Deliberately uses a
 * dedicated world id and its own player/tournament id namespace so it
 * never collides with seed.ts's fixtures; safe to run against a
 * database seed.ts has already populated.
 *
 * MUST be run with WORLD_ID=junior-walkthrough set in the environment
 * — composition.ts's rank-position queries (deps.rankPosition /
 * rankPositionU14 / rankPositionU16) are built once at startup against
 * a single module-level WorldId read from that env var (defaulting to
 * 'main'), not parameterized per call. Running this script against a
 * dedicated world without matching WORLD_ID would silently read the
 * WRONG world's current week for the rolling-ranking-window
 * calculation (RankingCalculationService.calculateTotal filters
 * ledger entries by weeksBetween(entry.weekEarned, currentWeek) >= 0,
 * so a mismatched clock can exclude entries that are genuinely within
 * the window, or worse, look like they're "in the future"). This is a
 * real, previously-undetected consequence of this codebase currently
 * only ever really running ONE game world at a time (every composition
 * root, worker included, is built around a single WORLD_ID) — not
 * something this script works around silently.
 *
 * Every player below is acquired through the REAL
 * ClaimTalentPoolCandidateUseCase — no more direct Player.hire(). Two
 * things are still pre-seeded rather than left to real randomness, for
 * a controllable, repeatable demo (the exact same shortcut seed.ts and
 * apps/worker/src/e2e.smoke.test.ts already take):
 *   1. Free-agent player ids are fixed/sequential, not real UUIDs.
 *   2. The "star" player's exact age is pinned near the top of
 *      TALENT_POOL_AGE_RANGE so the U16->senior graduation boundary is
 *      only 2 weekly ticks away, not up to ~103.
 * The CLAIM itself — XP pricing, the atomic claim+charge, the roster
 * cap check, signing the free agent with its own generated
 * ageInWeeks — is exactly what a real manager triggers via
 * POST /talent-pool/:id/claim.
 *
 * Real consequence of TALENT_POOL_AGE_RANGE = 14-16yo starting exactly
 * at the U14/U16 boundary (14*52 weeks): RankingBand.juniorEligibilityForAge
 * used to use a strict `<` check there, which meant NO generated player
 * could ever land in U14 — only U16 or older, regardless of the age
 * range. That was a real bug (real Tennis Europe eligibility is
 * inclusive, "14-and-under"), fixed by making the boundary check `<=`.
 * Step 3 below deliberately claims a second player at exactly
 * TALENT_POOL_AGE_RANGE.minWeeks to prove U14 is now genuinely
 * reachable through the real claim path, not just U16 — see
 * docs/junior-circuit-research-and-proposal.md's status section for
 * the full story (including why U14 stays RARE, not abundant, in the
 * ordinary weekly batch even after the fix).
 */

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const worldId = WorldId('junior-walkthrough');
const AMPLE_XP = 100_000; // comfortably more than any common/strong-tier candidate could ever cost
const COHORT_SIZE = 16; // fills one draw exactly, no byes to reason about
const PLAYERS_PER_MANAGER = 2; // stays within the free-tier roster cap, same convention as seed.ts
// 2 weeks short of TALENT_POOL_AGE_RANGE.maxWeeks (831) -> 832 (16*52,
// the real U16/senior boundary) in exactly 2 ticks, fast enough for
// this script without being an unrealistic age to generate.
const STAR_AGE_WEEKS = TALENT_POOL_AGE_RANGE.maxWeeks - 1;
// Exactly the pool's minimum age — the ONE integer week in the whole
// range that lands in U14 (see this file's header comment). Not a
// random roll: deliberately pinned, same "shape the setup, not the
// outcome" reasoning as STAR_AGE_WEEKS above, to reliably demonstrate
// U14 reachability rather than relying on a ~1-in-206 chance per batch.
const PRODIGY_AGE_WEEKS = TALENT_POOL_AGE_RANGE.minWeeks;

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...args);
}

function managerIdFor(cohortIndex: number): ReturnType<typeof ManagerId> {
  return ManagerId(`jw-m${Math.ceil(cohortIndex / PLAYERS_PER_MANAGER)}`);
}

/** Deliberately strong, fixed attributes for the "star" candidate —
 * makes winning LIKELY, not certain: StatisticalMatchSimulator still
 * genuinely simulates every match, this just avoids relying on a ~1%
 * exceptional-tier roll to get a meaningful demonstration of
 * graduation carryover firing within one script run. No different in
 * spirit from picking the star's age near the U16/senior boundary for
 * speed — shaping the setup, not the outcome. */
function strongAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(88), forehand: Skill.of(90), backhand: Skill.of(87), volley: Skill.of(85) },
    physical: { speed: Skill.of(89), stamina: Skill.of(86), strength: Skill.of(85) },
    mental: { consistency: Skill.of(88), clutch: Skill.of(90) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

async function main(): Promise<void> {
  if ((process.env.WORLD_ID ?? 'main') !== worldId) {
    throw new Error(
      `This script must be run with WORLD_ID=${worldId} set (got ${process.env.WORLD_ID ?? '<unset, defaults to "main">'}) ` +
        `— see this file's header comment for why a mismatched WORLD_ID silently breaks ranking reads.`,
    );
  }

  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory: process.env.MATCH_LOG_DIR ?? './data/match-logs',
    logEvent: () => {},
  });
  const random: RandomSource = { next: () => Math.random() };
  const generationPolicy = new StandardPlayerGenerationPolicy();
  const agingPolicy = new StandardAgingPolicy();

  async function saveFreeAgent(
    id: PlayerId,
    name: string,
    ageInWeeks: number,
    attributes: PlayerAttributes,
    nationality: string,
    potentialCeiling: number,
    physicalCeilings: { speed: number; stamina: number; strength: number },
  ): Promise<void> {
    if (await deps.players.findById(id)) return;
    await deps.players.save(
      Player.generateFillOnly(
        id,
        name,
        ageInWeeks,
        agingPolicy.stageForAge(ageInWeeks),
        attributes,
        nationality,
        potentialCeiling,
        physicalCeilings,
      ),
    );
  }

  async function signFreeAgent(id: PlayerId, managerId: ManagerId): Promise<Player> {
    const existing = await deps.players.findById(id);
    if (existing?.managerId !== null && existing !== null) return existing;
    return deps.claimTalentPoolCandidate.execute({ playerId: id, managerId });
  }

  log('=== 0. World setup ===');
  if (!(await deps.worlds.findById(worldId))) {
    await deps.worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    log(`Created world "${worldId}" at season 1, week 1.`);
  } else {
    log(`World "${worldId}" already exists (rerun) — using its current state.`);
  }

  async function advanceOneDayForPacing(reason: string): Promise<void> {
    // Matches are now day-paced (SimulateDueMatchesUseCase only plays a
    // round once its scheduled day arrives). This walkthrough isn't
    // testing pacing, so it advances ONLY the day clock — directly on
    // the aggregate, bypassing AdvanceWorldWeekUseCase — so no aging /
    // junior-generation / weekly side effects fire mid-draw and perturb
    // the ranking/graduation assertions later in the script.
    const w = (await deps.worlds.findById(worldId))!;
    w.advanceDay(`walkthrough-${reason}-${Date.now()}`);
    await deps.worlds.save(w);
  }

  log('\n=== 1. Real weekly talent-pool batch generation (RefreshTalentPoolUseCase, the actual worker-tick wiring) ===');
  const refreshResult = await deps.refreshTalentPool.execute({ worldId });
  log(`RefreshTalentPoolUseCase: generated=${refreshResult.generated}`);
  const availableAfterRefresh = (await deps.players.findFreeAgents()).filter(
    (p) => p.ageInWeeks >= TALENT_POOL_AGE_RANGE.minWeeks && p.ageInWeeks <= TALENT_POOL_AGE_RANGE.maxWeeks,
  );
  const sample = availableAfterRefresh.slice(0, 5);
  log(`Sample of ${sample.length} of the ${availableAfterRefresh.length} available free agents (proving the real 14-16yo range):`);
  for (const c of sample) {
    const years = (c.ageInWeeks / 52).toFixed(2);
    log(`  ${c.name}: age ${c.ageInWeeks}wk (${years}y), band ${juniorEligibilityForAge(c.ageInWeeks)}`);
  }
  const allInRange = availableAfterRefresh.every(
    (c) => c.ageInWeeks >= TALENT_POOL_AGE_RANGE.minWeeks && c.ageInWeeks <= TALENT_POOL_AGE_RANGE.maxWeeks,
  );
  const bandCounts = { u14: 0, u16: 0, senior: 0 };
  for (const c of availableAfterRefresh) bandCounts[juniorEligibilityForAge(c.ageInWeeks)] += 1;
  log(
    `All ${availableAfterRefresh.length} available candidates within TALENT_POOL_AGE_RANGE: ${allInRange}. ` +
      `Band split: u14=${bandCounts.u14}, u16=${bandCounts.u16}, senior=${bandCounts.senior} ` +
      `(u14 is rare by construction — only the exact minimum-age week qualifies, ~1 in 206 generations; ` +
      `step 3 below claims one deliberately rather than waiting for the batch to roll one).`,
  );

  log('\n=== 2. Claim the "star" through the REAL ClaimTalentPoolCandidateUseCase ===');
  const starManagerId = managerIdFor(1);
  await deps.managerXp.credit(starManagerId, AMPLE_XP);
  const starPlayerId = PlayerId('jw-star');
  const starGenerated = generationPolicy.generate(random, TALENT_POOL_AGE_RANGE);
  await saveFreeAgent(starPlayerId, 'Young Star', STAR_AGE_WEEKS, strongAttributes(), starGenerated.nationality, 100, {
    speed: 100,
    stamina: 100,
    strength: 100,
  });
  const star = await signFreeAgent(starPlayerId, starManagerId);
  log(
    `Claimed "${star.name}" (${star.id}) for manager ${starManagerId} — age ${star.ageInWeeks}wk ` +
      `(${(star.ageInWeeks / 52).toFixed(2)}y), currently ${juniorEligibilityForAge(star.ageInWeeks)}-eligible. ` +
      `This came from the SAME claim path a real manager uses — no Player.hire() shortcut.`,
  );

  log('\n=== 3. Claim a "prodigy" at exactly the pool\'s minimum age, to prove U14 is now reachable through the real claim path ===');
  // A dedicated manager, NOT managerIdFor(2) — that id is reserved for
  // the step-6 cohort's own roster-cap accounting (managerIdFor(1) and
  // managerIdFor(2) both resolve to jw-m1, which already owns the star;
  // reusing it here would silently eat the roster slot step 6 expects).
  const prodigyManagerId = ManagerId('jw-m-prodigy');
  await deps.managerXp.credit(prodigyManagerId, AMPLE_XP);
  const prodigyPlayerId = PlayerId('jw-prodigy');
  const prodigyGenerated = generationPolicy.generate(random, TALENT_POOL_AGE_RANGE);
  await saveFreeAgent(
    prodigyPlayerId,
    'Young Prodigy',
    PRODIGY_AGE_WEEKS,
    prodigyGenerated.attributes,
    prodigyGenerated.nationality,
    prodigyGenerated.potentialCeiling,
    prodigyGenerated.physicalCeilings,
  );
  const prodigy = await signFreeAgent(prodigyPlayerId, prodigyManagerId);
  const prodigyBand = juniorEligibilityForAge(prodigy.ageInWeeks);
  log(
    `Claimed "${prodigy.name}" (${prodigy.id}) — age ${prodigy.ageInWeeks}wk (exactly ${(prodigy.ageInWeeks / 52).toFixed(2)}y, ` +
      `TALENT_POOL_AGE_RANGE.minWeeks), currently ${prodigyBand}-eligible.`,
  );
  if (prodigyBand !== 'u14') {
    throw new Error(`Expected the prodigy (age ${prodigy.ageInWeeks}wk) to be U14-eligible, got "${prodigyBand}" — the boundary fix regressed.`);
  }
  log('  Confirmed: a REAL claimed player (no Player.hire() shortcut) is U14-eligible. The boundary bug is fixed.');

  log('\n=== 4. This week\'s open junior tournaments, both bands ===');
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
  log(`U14 band (${byBand.u14.length}): ${byBand.u14.join(', ')}`);
  log(`U16 band (${byBand.u16.length}): ${byBand.u16.join(', ')}`);

  log('\n=== 5. Register the prodigy into a real U14 tournament — closing the loop, not just checking eligibility in isolation ===');
  const u14Target = openThisWeek.find((t) => t.ageBand === 'u14');
  if (!u14Target) throw new Error('No U14 tournament open this week — cannot demonstrate real U14 registration.');
  await deps.registerEntrant.execute({ tournamentId: u14Target.id, playerId: prodigy.id });
  log(`  Registered "${prodigy.name}" into U14 ${u14Target.tier} (${u14Target.id}) — OK.`);

  log('\n=== 6. Enter the star into 3 U16 tournaments, then confirm a 4th is rejected (weekly cap) ===');
  const u16ThisWeek = openThisWeek.filter((t) => t.ageBand === 'u16');
  const chosen = u16ThisWeek.slice(0, 4); // 3 should succeed, the 4th should be rejected
  for (let i = 0; i < 3; i++) {
    await deps.registerEntrant.execute({ tournamentId: chosen[i].id, playerId: star.id });
    log(`  Registered into ${chosen[i].tier} (${chosen[i].id}) — OK (entry ${i + 1}/3)`);
  }
  try {
    await deps.registerEntrant.execute({ tournamentId: chosen[3].id, playerId: star.id });
    log(`  UNEXPECTED: 4th registration into ${chosen[3].tier} (${chosen[3].id}) succeeded — cap did not fire!`);
  } catch (error) {
    log(`  4th registration into ${chosen[3].tier} (${chosen[3].id}) REJECTED: ${(error as Error).message}`);
  }

  log('\n=== 7. Fill one of those draws (16 players, all REALLY claimed) and simulate it to completion ===');
  const fillTarget = chosen[0];
  log(`Filling ${fillTarget.tier} (${fillTarget.id}) — star already entered, claiming and adding ${COHORT_SIZE - 1} more.`);
  const cohortIds: PlayerId[] = [star.id];
  for (let i = 2; i <= COHORT_SIZE; i++) {
    const managerId = managerIdFor(i);
    await deps.managerXp.credit(managerId, AMPLE_XP);
    const playerId = PlayerId(`jw-p${i}`);
    const generated = generationPolicy.generate(random, TALENT_POOL_AGE_RANGE);
    await saveFreeAgent(
      playerId,
      `Junior Player ${i}`,
      generated.ageInWeeks,
      generated.attributes,
      generated.nationality,
      generated.potentialCeiling,
      generated.physicalCeilings,
    );
    const player = await signFreeAgent(playerId, managerId);
    await deps.registerEntrant.execute({ tournamentId: fillTarget.id, playerId: player.id });
    cohortIds.push(player.id);
  }
  const filled = await deps.tournaments.findById(fillTarget.id);
  log(`Draw filled: hasStarted=${filled!.hasStarted}, entrants=${filled!.entrants.length}`);

  log('Cascading SimulateDueMatchesUseCase until the tournament is finished...');
  for (let round = 1; round <= 8; round++) {
    await advanceOneDayForPacing(`j-sweep-${round}`);
    const result = await deps.simulateDueMatches.execute({ worldId });
    log(`  sweep ${round}: simulated=${result.simulated.length}, failed=${result.failed.length}`);
    for (const f of result.failed) log(`    FAILED: ${f.matchId} - ${f.reason}`);
    if (result.simulated.length === 0) break;
  }

  log('\n=== 8. Real ranking points, straight from the ledger ===');
  const ledgerEntries = (await Promise.all(cohortIds.map((id) => deps.rankingLedger.findByPlayer(id)))).flat();
  const byPoints = [...ledgerEntries].sort((a, b) => b.points - a.points);
  for (const entry of byPoints) {
    log(`  ${entry.playerId}: ${entry.points} points (tier ${entry.tier}, ageBand ${entry.ageBand})`);
  }
  const zeroCount = byPoints.filter((e) => e.points === 0).length;
  const positiveCount = byPoints.filter((e) => e.points > 0).length;
  log(`  -> ${zeroCount} first-round-loss entries at 0 points, ${positiveCount} entries with real points > 0.`);

  const starRankU16 = await deps.rankPositionU16.rankFor(star.id);
  log(`Star player's U16 ranking right now: rank=${starRankU16.rank}, totalPoints=${starRankU16.totalPoints}`);

  log('\n=== 9. Advance the world week-by-week until the star crosses U16 -> senior ===');
  // A week is now 7 day-ticks; aging/graduation fire only on the day-7
  // rollover. Advance FULL weeks so the star actually ages a week per
  // "tick" of this section, as it did before the day clock existed.
  for (let week = 1; week <= 3; week++) {
    let rolled = false;
    for (let day = 1; day <= 7 && !rolled; day++) {
      const advanceResult = await deps.advanceWorldWeek.execute({ worldId, tickKey: `jw-tick-${Date.now()}-${week}-${day}` });
      rolled = advanceResult.weekRolledOver;
      if (rolled) {
        await deps.generateJuniorTournaments.execute({ worldId });
      }
    }
    const w = (await deps.worlds.findById(worldId))!;
    const starNow = (await deps.players.findById(star.id))!;
    const band = juniorEligibilityForAge(starNow.ageInWeeks);
    log(
      `  Week ${week}: week=${JSON.stringify(w.currentWeek)}, star age=${starNow.ageInWeeks} weeks, ` +
        `band=${band}, dormantCarryoverBonus=${JSON.stringify(starNow.dormantCarryoverBonus)}`,
    );
    if (band === 'senior') break;
  }

  log('\n=== 10. Open a fresh SENIOR tournament, register the (now-senior) star + cohort, simulate, look for carryover firing ===');
  const world2 = (await deps.worlds.findById(worldId))!;
  const seniorTournamentId = TournamentId('jw-senior-1');
  if (!(await deps.tournaments.findById(seniorTournamentId))) {
    await deps.openRegistration.execute({
      tournamentId: seniorTournamentId,
      tier: 'futures',
      surface: 'hard',
      weekScheduled: world2.currentWeek,
      drawSize: COHORT_SIZE,
    });
    log(
      `  Opened senior tournament "${seniorTournamentId}" (futures, hard, ${COHORT_SIZE}-draw). The senior tour has no ` +
        `age floor — a junior-age player entering it is a deliberately UNRESTRICTED case (real tennis allows turning ` +
        `pro before 18), not the gap that was fixed. isAgeEligibleForTournamentBand only ever blocks the OTHER ` +
        `direction (too old for a real u14/u16 draw), so the cohort — still nominally youth-age by generation — ` +
        'enters this senior draw exactly as a real manager could do today.',
    );
  }
  for (const id of cohortIds) {
    await deps.registerEntrant.execute({ tournamentId: seniorTournamentId, playerId: id });
  }
  const startedSenior = await deps.tournaments.findById(seniorTournamentId);
  log(`  hasStarted=${startedSenior!.hasStarted}`);

  const dormantBefore = new Map<string, unknown>();
  for (const id of cohortIds) {
    dormantBefore.set(id, (await deps.players.findById(id))!.dormantCarryoverBonus);
  }

  log('  Simulating until the draw is finished (so winners get a second match, giving carryover a real chance to fire)...');
  for (let sweep = 1; sweep <= 8; sweep++) {
    await advanceOneDayForPacing(`senior-sweep-${sweep}`);
    const simResult = await deps.simulateDueMatches.execute({ worldId });
    log(`    sweep ${sweep}: simulated=${simResult.simulated.length}, failed=${simResult.failed.length}`);
    for (const f of simResult.failed) log(`      FAILED: ${f.matchId} - ${f.reason}`);
    if (simResult.simulated.length === 0) break;
  }

  const seniorEntries = (await Promise.all(cohortIds.map((id) => deps.rankingLedger.findByPlayer(id)))).flat();
  const newSeniorEntries = seniorEntries.filter((e) => e.ageBand === null);
  let firedForAnyone = false;
  for (const entry of newSeniorEntries) {
    const before = dormantBefore.get(entry.playerId);
    const player = await deps.players.findById(entry.playerId);
    const consumed = before !== null && player!.dormantCarryoverBonus === null;
    log(
      `  ${entry.playerId}: senior result = ${entry.points} points; had dormant bonus before = ` +
        `${JSON.stringify(before)}; carryover fired this match = ${consumed}`,
    );
    if (consumed) firedForAnyone = true;
  }
  log(
    firedForAnyone
      ? '  -> Graduation carryover FIRED for at least one player.'
      : "  -> No qualifying win occurred this round for anyone still holding a dormant bonus (0-point losses don't consume it) — real outcome, not staged.",
  );

  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

