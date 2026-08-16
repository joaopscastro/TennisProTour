import 'dotenv/config';
import { GameWorld, WorldId } from '@tennis-manager/domain';
import { createDb } from '../db/client';
import { buildDependencies } from '../composition';

/**
 * On-demand run of the recurring fill-only safe guard
 * (EnsureFillOnlyPopulationUseCase) — tops the draw-filler population up
 * to its per-band floor across all ages, without waiting for the next
 * weekly rollover. Safe to run any time: idempotent (only generates the
 * shortfall), so re-running is a no-op once every band is at its floor.
 *
 * This is the same guard apps/worker runs every weekly rollover, exposed
 * as a script for immediate remediation (e.g. after a heavy claim wave
 * drains the senior filler pool, run this before the next tournament
 * start).
 *
 * Run: npm run build -w apps/api && node dist/scripts/ensureFillOnlyPlayers.js
 */
const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';

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
  console.log('Ensuring fill-only population meets its per-band floor...');
  const result = await deps.ensureFillOnlyPopulation.execute({ worldId });

  const fillOnly = (await deps.players.findAll()).filter((p) => p.fillOnly);
  // eslint-disable-next-line no-console
  console.log(`Generated ${result.generated} fill-only player(s) this run.`);
  // eslint-disable-next-line no-console
  console.log(`Total fill-only players now in world "${worldId}": ${fillOnly.length}`);

  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
