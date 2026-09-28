import 'dotenv/config';
import { WorldId } from '@tennis-manager/domain';
import { createDb } from '../db/client';
import { buildDependencies } from '../composition';
import { resolveMatchLogDirectory } from '../matchLogDirectory';

/**
 * On-demand run of the dead-draw RESCUE (item 2.1) for a world that
 * already has started-but-singles-unseeded draws: every such draw is
 * handed to the real `StartDueTournamentsUseCase` — the same weekly
 * system the worker runs — which either fills and seeds its singles
 * bracket (seed-if-fillable) or cancels it past the grace window
 * (cancel-if-not), releasing the players its entries trapped.
 *
 * This is not a separate code path: `StartDueTournamentsUseCase.execute`
 * already performs the rescue on every weekly rollover. The script
 * exists so an operator can repair an existing world immediately, and
 * so a live verification run can report exactly what the rescue did to
 * each known dead draw (seeded / cancelled / left).
 *
 * Also reports the run's fill-selection counters (see
 * FillDrawSlotsDiagnostics) — the evidence the 52-week agent season's
 * findings explicitly could not capture.
 *
 * Run (same env conventions as every script):
 *   DATABASE_URL=... WORLD_ID=agents npm run build -w apps/api
 *   node apps/api/dist/scripts/rescueDeadDraws.js
 */
const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';

async function main(): Promise<void> {
  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory: resolveMatchLogDirectory(),
    // eslint-disable-next-line no-console
    logEvent: (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
  });

  const worldId = WorldId(process.env.WORLD_ID ?? 'main');
  const before = (await deps.tournaments.findStartedSinglesUnseeded?.()) ?? [];
  // eslint-disable-next-line no-console
  console.log(`Dead draws before this run: ${before.length}`);

  const result = await deps.startDueTournaments.execute({ worldId });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ result }));

  for (const dead of before) {
    const after = await deps.tournaments.findById(dead.id);
    const outcome = !after
      ? 'deleted'
      : after.isCancelled
        ? 'cancelled'
        : after.hasMainDraw || after.hasQualifyingDrawStarted
          ? 'seeded'
          : 'left';
    // eslint-disable-next-line no-console
    console.log(`${outcome}\t${dead.id}\t${dead.name}`);
  }

  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
