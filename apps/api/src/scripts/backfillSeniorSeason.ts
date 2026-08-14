import 'dotenv/config';
import { WorldId } from '@tennis-manager/domain';
import { createDb } from '../db/client';
import { buildDependencies } from '../composition';

/**
 * One-off backfill: opens the senior-tour slate for every week from the
 * world's CURRENT week through the end of its season (week 52), so the
 * rest of the season is "full filled" immediately rather than waiting
 * one weekly worker tick per week.
 *
 * Goes through the real GenerateSeniorTournamentsUseCase — the same use
 * case apps/worker calls every rollover — with an explicit `week` for
 * each target week (the backfill path the use case supports). Safe to
 * re-run: the use case skips any (week, tier) that already has an open
 * senior tournament, and the worker's own weekly generation will skip
 * weeks this script already filled.
 *
 * Run: npm run build -w apps/api && node dist/scripts/backfillSeniorSeason.js
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory: process.env.MATCH_LOG_DIR ?? './data/match-logs',
    // eslint-disable-next-line no-console
    logEvent: () => {},
  });

  const worldId = WorldId(process.env.WORLD_ID ?? 'main');
  const world = await deps.worlds.findById(worldId);
  if (!world) {
    // eslint-disable-next-line no-console
    console.error(`Game world ${worldId} not found — run the seed/setup first.`);
    process.exit(1);
  }

  const startWeek = world.currentWeek.week;

  // eslint-disable-next-line no-console
  console.log(`World is at S${world.currentWeek.season}W${startWeek}. Backfilling senior tournaments through week 52...`);
  let openedTotal = 0;
  for (let week = startWeek; week <= 52; week++) {
    const result = await deps.generateSeniorTournaments.execute({
      worldId,
      week: { season: world.currentWeek.season, week },
    });
    // eslint-disable-next-line no-console
    console.log(`  S${world.currentWeek.season}W${week}: opened ${result.opened} senior tournament(s)`);
    openedTotal += result.opened;
  }
  // eslint-disable-next-line no-console
  console.log(`Done — ${openedTotal} senior tournament(s) opened across the rest of the season.`);

  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
