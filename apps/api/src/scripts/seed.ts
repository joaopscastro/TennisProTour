import 'dotenv/config';
import { GameWorld, ManagerId, PlayerId, StandardPlayerGenerationPolicy, TalentPoolCandidate, TalentPoolCandidateId, TournamentId, WorldId } from '@tennis-manager/domain';
import { TALENT_POOL_AGE_RANGE } from '@tennis-manager/application';
import { createDb } from '../db/client';
import { buildDependencies } from '../composition';
import { MathRandomSource } from '../adapters/outbound/MathRandomSource';

/**
 * Dev seed script: populates the docker-compose Postgres with enough
 * data to click through the whole loop in the web app — roster,
 * bracket, simulate a match, watch the replay. Goes through the same
 * use cases the API and worker do (buildDependencies), not raw SQL or
 * HTTP, so seeded data is exactly as valid as anything the app itself
 * would produce.
 *
 * A "handful" of players (10) registered into a 16-draw — the
 * smallest draw size the domain supports (DrawSize is 16/32/64/128,
 * no 8) — deliberately leaves it short of full: that's 2 real round-1
 * matches to simulate/replay by hand, plus 6 byes carrying straight
 * into round 2, so the seed also demonstrates that path without any
 * extra setup.
 *
 * Idempotent-ish: reruns against data left by a previous run fail
 * loudly (duplicate ids) rather than silently duplicating or
 * resetting — run `npm run db:migrate` against a clean database first
 * if you want a fresh start.
 */

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const port = Number(process.env.PORT ?? 3000);
const matchLogDirectory = process.env.MATCH_LOG_DIR ?? './data/match-logs';
const webBaseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:3001';

const TOURNAMENT_ID = 'seed-open';
const REGISTRATION_TOURNAMENT_ID = 'seed-registration';
const PLAYER_COUNT = 10;
const DRAW_SIZE = 16;
const PLAYERS_PER_MANAGER = 2; // stays within the free-tier roster cap
const NATIONALITIES = ['BR', 'US', 'FR', 'JP', 'AU', 'DE', 'AR', 'GB', 'ES', 'SE'];

async function main(): Promise<void> {
  const db = createDb(connectionString);
  const deps = buildDependencies({
    db,
    matchLogDirectory,
    matchLogPublicBaseUrl: process.env.MATCH_LOG_PUBLIC_BASE_URL ?? `http://localhost:${port}/match-logs`,
    // eslint-disable-next-line no-console
    logEvent: (message, payload) => console.log(JSON.stringify({ msg: message, ...payload })),
  });

  // Hiring is pool-based now (see docs/CLAUDE.md) — there's no more
  // "hire any player on demand" use case. This script still needs
  // predictable ids for the demo instructions below (bracket URLs,
  // "manager id seed-m1"), so it seeds talent pool candidates directly
  // with fixed ids rather than going through RefreshTalentPoolUseCase's
  // random batch/random-id generation, then claims each one through
  // the REAL ClaimTalentPoolCandidateUseCase — the actual
  // ownership-transfer step this script cares about demonstrating.
  const worldId = WorldId(process.env.WORLD_ID ?? 'main');
  if (!(await deps.worlds.findById(worldId))) {
    await deps.worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  }
  const generationPolicy = new StandardPlayerGenerationPolicy();
  const random = new MathRandomSource();

  // eslint-disable-next-line no-console
  console.log(`Seeding and claiming ${PLAYER_COUNT} talent pool candidates...`);
  // Claiming costs XP (TalentClaimPricingPolicy) — fund every manager
  // this script is about to claim on behalf of BEFORE the first claim,
  // same pattern api.integration.test.ts's hirePlayer() helper already
  // uses (deps.managerXp.credit(...) before claiming). 100_000 is
  // deliberately far above any real claim cost (super-linear off
  // overallRating, capped by what this policy can even produce), not a
  // tuned number — it just needs to never be the thing that fails a
  // dev seed run.
  const AMPLE_SEED_XP = 100_000;
  const fundedManagers = new Set<string>();
  const entrants: Array<{ playerId: string; seed: number; managerId: string }> = [];
  for (let i = 1; i <= PLAYER_COUNT; i++) {
    const playerId = `seed-p${i}`;
    const managerId = `seed-m${Math.ceil(i / PLAYERS_PER_MANAGER)}`;
    if (!fundedManagers.has(managerId)) {
      await deps.managerXp.credit(ManagerId(managerId), AMPLE_SEED_XP);
      fundedManagers.add(managerId);
    }
    const generated = generationPolicy.generate(random, TALENT_POOL_AGE_RANGE);
    await deps.talentPoolCandidates.save(
      TalentPoolCandidate.generate(
        TalentPoolCandidateId(playerId),
        { ...generated, name: `Seed Player ${i}`, nationality: NATIONALITIES[(i - 1) % NATIONALITIES.length] },
        { season: 1, week: 1 },
      ),
    );
    await deps.claimTalentPoolCandidate.execute({
      candidateId: TalentPoolCandidateId(playerId),
      managerId: ManagerId(managerId),
    });
    entrants.push({ playerId, seed: i, managerId });
    // eslint-disable-next-line no-console
    console.log(`  claimed ${playerId} (manager ${managerId}, tier: ${generated.tier})`);
  }

  // eslint-disable-next-line no-console
  console.log(`\nOpening tournament "${TOURNAMENT_ID}" (${DRAW_SIZE}-draw, clay, challenger)...`);
  await deps.openTournament.execute({
    tournamentId: TournamentId(TOURNAMENT_ID),
    tier: 'challenger',
    surface: 'clay',
    weekScheduled: { season: 1, week: 1 },
    drawSize: DRAW_SIZE,
    entrants: entrants.map((e) => ({ playerId: PlayerId(e.playerId), seed: e.seed })),
  });

  const tournament = await deps.tournaments.findById(TournamentId(TOURNAMENT_ID));
  const round1 = tournament!.getRounds()[0];
  const byeCount = PLAYER_COUNT - round1.matches.length * 2;

  // eslint-disable-next-line no-console
  console.log(
    `Tournament started: round 1 has ${round1.matches.length} playable match(es); ` +
      `${byeCount} entrant(s) carry a bye straight into round 2.`,
  );
  // A second tournament, genuinely open for registration (no entrants,
  // not started) — what a roster row's "Enter" action needs something
  // real to register into. seed-p1..seed-p4 (2 free-tier managers'
  // full rosters) enter it via the same RegisterEntrantUseCase the
  // "Enter" button calls, deliberately left short of the 16-draw so
  // it's still open afterward for manual testing in the web app.
  // eslint-disable-next-line no-console
  console.log(`\nOpening "${REGISTRATION_TOURNAMENT_ID}" for registration (${DRAW_SIZE}-draw, hard, futures)...`);
  await deps.openRegistration.execute({
    tournamentId: TournamentId(REGISTRATION_TOURNAMENT_ID),
    tier: 'futures',
    surface: 'hard',
    weekScheduled: { season: 1, week: 2 },
    drawSize: DRAW_SIZE,
  });
  for (let i = 1; i <= 4; i++) {
    await deps.registerEntrant.execute({ tournamentId: TournamentId(REGISTRATION_TOURNAMENT_ID), playerId: PlayerId(`seed-p${i}`) });
  }
  // eslint-disable-next-line no-console
  console.log(`  4 of ${DRAW_SIZE} slots filled — still open for entrants.`);

  // eslint-disable-next-line no-console
  console.log('\nDone! In the web app:');
  // eslint-disable-next-line no-console
  console.log(`  Roster   ${webBaseUrl}/  (try manager id "seed-m1")`);
  // eslint-disable-next-line no-console
  console.log(`  Bracket  ${webBaseUrl}/tournaments/${TOURNAMENT_ID}`);
  // eslint-disable-next-line no-console
  console.log('  Click "Simulate" on a round-1 match, then "watch replay" for the fake-live playback.');
  // eslint-disable-next-line no-console
  console.log(`  "Enter" from the roster page has "${REGISTRATION_TOURNAMENT_ID}" available to register into.`);

  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
