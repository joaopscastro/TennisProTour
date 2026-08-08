import 'dotenv/config';
import { GameWorld, WorldId } from '@tennis-manager/domain';
import { createDb } from '../db/client';
import { buildDependencies } from '../composition';

/**
 * One-time genesis seed (docs/tournament-fill-system.md item 3): run
 * this exactly once, right after a new world's first migration, before
 * the weekly tick has had years of simulated time to age the normal
 * 14-16yo talent-pool pipeline into every band a tournament might need
 * a filler from. NOT a recurring job — do not wire this into
 * apps/worker's scheduler (contrast npm run seed's own dev-demo data,
 * which is also a one-shot script, and RefreshTalentPoolUseCase, which
 * genuinely IS recurring).
 *
 * Safe to run against a world that already has managed players/a
 * demo roster (e.g. after `npm run seed`) — this only ever ADDS
 * fill-only free agents (Player.generateFillOnly, managerId: null),
 * never touches anything else. Not safe to run twice without
 * consequence, though: nothing here checks for a prior run, so a
 * second run just doubles the fill-only population rather than erroring
 * — matches seed.ts's own "operator discipline, not enforcement"
 * one-shot-script convention.
 *
 * Override population via GENESIS_POPULATION env var (defaults to
 * GenesisSeedFillOnlyPlayersUseCase's own GENESIS_POPULATION, 300).
 */
const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const populationOverride = process.env.GENESIS_POPULATION ? Number(process.env.GENESIS_POPULATION) : undefined;

async function main(): Promise<void> {
  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory: process.env.MATCH_LOG_DIR ?? './data/match-logs',
    // eslint-disable-next-line no-console
    logEvent: (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
  });

  const worldId = WorldId(process.env.WORLD_ID ?? 'main');
  if (!(await deps.worlds.findById(worldId))) {
    await deps.worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  }

  // eslint-disable-next-line no-console
  console.log('Genesis-seeding fill-only free agents (one-time, full 14-37yo age spread)...');
  const result = await deps.genesisSeedFillOnlyPlayers.execute({ worldId, population: populationOverride });

  const allPlayers = await deps.players.findAll();
  const fillOnly = allPlayers.filter((p) => p.fillOnly);
  const ageBuckets = new Map<number, number>();
  const stageCounts = new Map<string, number>();
  for (const p of fillOnly) {
    const years = Math.floor(p.ageInWeeks / 52);
    ageBuckets.set(years, (ageBuckets.get(years) ?? 0) + 1);
    stageCounts.set(p.stage, (stageCounts.get(p.stage) ?? 0) + 1);
  }

  // eslint-disable-next-line no-console
  console.log(`\nGenerated ${result.generated} fill-only players this run.`);
  // eslint-disable-next-line no-console
  console.log(`Total fill-only players now in world "${worldId}": ${fillOnly.length}`);
  // eslint-disable-next-line no-console
  console.log('\nAge distribution (years -> count):');
  for (const [years, count] of [...ageBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    // eslint-disable-next-line no-console
    console.log(`  ${years}: ${count}`);
  }
  // eslint-disable-next-line no-console
  console.log('\nLifecycle stage distribution:');
  for (const [stage, count] of stageCounts.entries()) {
    // eslint-disable-next-line no-console
    console.log(`  ${stage}: ${count}`);
  }

  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
