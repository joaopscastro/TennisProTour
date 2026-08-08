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
const NATIONALITIES = ['BR', 'US', 'FR', 'JP', 'AU', 'DE', 'AR', 'GB', 'ES', 'SE', 'IT', 'CA', 'NL', 'RU', 'CN', 'KR', 'ZA', 'MX', 'PL', 'CH'];

/** Free-listed (unclaimed) talent-pool candidates for browsing/claiming
 * in the Scouting page — separate from the small claimed cohort above,
 * which the bracket walkthrough depends on and must stay untouched.
 * 200 candidates gives a real "shared pool, race to claim" feel instead
 * of the handful RefreshTalentPoolUseCase's real weekly batch produces. */
const FREE_AGENT_COUNT = 200;
/** Deliberately wider than TALENT_POOL_AGE_RANGE (14-16yo, the real
 * weekly refresh's actual constraint) — this is a dev-only seed script,
 * not RefreshTalentPoolUseCase, so it can generate across the whole
 * non-retired age span (StandardAgingPolicy: youth <20, prime 20-30,
 * decline 30-38) for richer manual testing of the Scouting page. Not
 * representative of what a real weekly refresh ever produces. */
const SEED_FREE_AGENT_AGE_RANGE = { minWeeks: 14 * 52, maxWeeks: 37 * 52 };

/** Additional senior tournaments (beyond TOURNAMENT_ID/
 * REGISTRATION_TOURNAMENT_ID above), open for registration with no
 * entrants, spanning all four senior tiers and every surface — so the
 * Tournaments page has real variety to browse, not just two fixtures. */
const EXTRA_SENIOR_TOURNAMENTS: Array<{ id: string; tier: 'futures' | 'challenger' | 'tour' | 'major'; surface: 'clay' | 'grass' | 'hard' | 'indoor'; drawSize: 16 | 32 | 64 | 128; week: number }> = [
  { id: 'seed-futures-clay', tier: 'futures', surface: 'clay', drawSize: 16, week: 1 },
  { id: 'seed-futures-hard', tier: 'futures', surface: 'hard', drawSize: 32, week: 2 },
  { id: 'seed-challenger-grass', tier: 'challenger', surface: 'grass', drawSize: 32, week: 1 },
  { id: 'seed-challenger-indoor', tier: 'challenger', surface: 'indoor', drawSize: 16, week: 2 },
  { id: 'seed-tour-hard', tier: 'tour', surface: 'hard', drawSize: 64, week: 1 },
  { id: 'seed-tour-clay', tier: 'tour', surface: 'clay', drawSize: 32, week: 3 },
  { id: 'seed-major-grass', tier: 'major', surface: 'grass', drawSize: 128, week: 4 },
  { id: 'seed-major-hard', tier: 'major', surface: 'hard', drawSize: 128, week: 5 },
];

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
  console.log(`\nSeeding ${FREE_AGENT_COUNT} unclaimed free-agent talent pool candidates (ages 14-37)...`);
  for (let i = 1; i <= FREE_AGENT_COUNT; i++) {
    const generated = generationPolicy.generate(random, SEED_FREE_AGENT_AGE_RANGE);
    await deps.talentPoolCandidates.save(
      TalentPoolCandidate.generate(
        TalentPoolCandidateId(`seed-free-${i}`),
        { ...generated, name: `Free Agent ${i}`, nationality: NATIONALITIES[i % NATIONALITIES.length] },
        { season: 1, week: 1 },
      ),
    );
  }
  // eslint-disable-next-line no-console
  console.log(`  seeded ${FREE_AGENT_COUNT} free agents, unclaimed and browsable at GET /talent-pool.`);

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
  console.log(`\nOpening ${EXTRA_SENIOR_TOURNAMENTS.length} more senior tournaments across futures/challenger/tour/major...`);
  for (const t of EXTRA_SENIOR_TOURNAMENTS) {
    await deps.openRegistration.execute({
      tournamentId: TournamentId(t.id),
      tier: t.tier,
      surface: t.surface,
      weekScheduled: { season: 1, week: t.week },
      drawSize: t.drawSize,
    });
    // eslint-disable-next-line no-console
    console.log(`  ${t.id} (${t.tier}, ${t.surface}, ${t.drawSize}-draw) open for registration.`);
  }

  // Real junior ladder (all six J-grades × both age bands) via the
  // actual weekly worker use case, not hand-rolled tournament-creation
  // logic — GenerateJuniorTournamentsUseCase is what apps/worker calls
  // every real tick, so this seeds exactly what a live world would have
  // after its first tick, not an approximation of it.
  // eslint-disable-next-line no-console
  console.log('\nGenerating this week\'s junior ladder (all J-grades, both age bands)...');
  const juniorResult = await deps.generateJuniorTournaments.execute({ worldId });
  // eslint-disable-next-line no-console
  console.log(`  opened ${juniorResult.opened} junior tournament(s); ${juniorResult.mastersHeld} juniorMasters field(s) held.`);

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
