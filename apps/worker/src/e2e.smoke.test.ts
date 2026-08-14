import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { GameWorld, ManagerId, Player, PlayerId, StandardAgingPolicy, StandardPlayerGenerationPolicy, TournamentId, WorldId } from '@tennis-manager/domain';
import { TALENT_POOL_AGE_RANGE } from '@tennis-manager/application';
import { buildDependencies, createDb, Dependencies, schema, testConnectionString } from '@tennis-manager/api';
import { makeSimulateDueMatchesHandler } from './jobs/handlers';

/**
 * The one end-to-end smoke test: hire player -> open tournament ->
 * register entrants -> simulate a match -> fetch and validate the
 * replay log, run against the real docker-compose Postgres AND real
 * Redis — not a fake of either. This is the test that proves the
 * architecture holds together, so it deliberately does NOT take the
 * shortcut of calling SimulateMatchUseCase or SimulateDueMatchesUseCase
 * directly: the match is simulated by handing a real BullMQ job to a
 * real Worker, exactly the path the scheduled 'simulate-due-matches'
 * job takes in production. Everything else (domain, application,
 * Drizzle adapters, filesystem replay store) is exercised exactly as
 * apps/api's own composition root wires it — no test-only shortcuts
 * there either.
 *
 * A dedicated queue name keeps this hermetic: apps/worker's own
 * repeatable schedulers (registered against the 'world'/'matches'
 * queues whenever the real worker process has run against this same
 * Redis) must not interfere with, or be interfered with by, this test.
 */

const connectionString = testConnectionString();
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const QUEUE_NAME = 'e2e-smoke-matches';
const WORLD_ID = 'main';
const TOURNAMENT_ID = TournamentId('e2e-smoke-t1');
const PLAYER_COUNT = 16; // fills the whole draw: every round-1 pairing is a real match, no byes to reason about
const DRAW_SIZE = 16;

describe('end-to-end smoke: hire -> open -> register -> simulate -> replay (real Postgres + real Redis)', () => {
  let matchLogDirectory: string;
  let deps: Dependencies;
  let connection: IORedis;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let worker: Worker;

  beforeAll(async () => {
    const db = createDb(connectionString);
    await migrate(db, { migrationsFolder: '../api/drizzle' });

    // Clean slate, same convention as the other integration suites
    // (child tables first, for the FKs).
    await db.delete(schema.rankingLedger);
    await db.delete(schema.titles);
    await db.delete(schema.peakRankings);
    await db.delete(schema.trainingSchedule);
    await db.delete(schema.tournamentMatches);
    await db.delete(schema.tournamentEntries);
    await db.delete(schema.doublesTitles);
    await db.delete(schema.tournaments);
    await db.delete(schema.doublesPairs);
    await db.delete(schema.doublesPeakRankings);
    await db.delete(schema.practiceSessions);
    await db.delete(schema.players);

    matchLogDirectory = await mkdtemp(join(tmpdir(), 'e2e-smoke-'));
    deps = buildDependencies({ db, matchLogDirectory, logEvent: () => {} });

    // SimulateDueMatchesUseCase reads the world clock to day-gate each
    // round (see docs/day-tick-and-scheduling.md). Put the world a week
    // AHEAD of the tournament's week-1 schedule so every round is due,
    // keeping this smoke test's single-sweep expectation intact.
    await deps.worlds.save(GameWorld.create(WorldId(WORLD_ID), { season: 1, week: 2 }));

    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAME, { connection });
    queueEvents = new QueueEvents(QUEUE_NAME, { connection: connection.duplicate() });
    await queueEvents.waitUntilReady();

    const simulateDueMatches = makeSimulateDueMatchesHandler(deps, WORLD_ID);
    worker = new Worker(QUEUE_NAME, async () => simulateDueMatches(), { connection });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await queueEvents.close();
    connection.disconnect();
    await rm(matchLogDirectory, { recursive: true, force: true });
  });

  it(
    'drives the full path end to end',
    async () => {
      // 1. Populate the free-agent pool with fixed-id Player rows, then
      // sign each one — via the same use case the HTTP layer calls
      // (ClaimTalentPoolCandidateUseCase). Hiring is pool-based now
      // (see docs/CLAUDE.md), so there's no more direct "hire any
      // player" use case; seeding fixed player ids directly (rather
      // than a real RefreshTalentPoolUseCase random batch) keeps this
      // test's downstream ids predictable, exactly like apps/api's own
      // seed script does for the same reason.
      const generationPolicy = new StandardPlayerGenerationPolicy();
      const agingPolicy = new StandardAgingPolicy();
      const random = { next: () => Math.random() };
      // Claiming costs XP (TalentClaimPricingPolicy) — fund each
      // manager before their first claim, same pattern
      // apps/api/src/scripts/seed.ts and api.integration.test.ts's
      // hirePlayer() helper use. 100_000 is deliberately far above any
      // real claim cost, not a tuned number.
      const AMPLE_XP_FOR_TESTS = 100_000;
      const fundedManagers = new Set<string>();
      for (let i = 1; i <= PLAYER_COUNT; i++) {
        const playerId = PlayerId(`e2e-p${i}`);
        const managerId = `e2e-m${Math.ceil(i / 2)}`; // 2/manager: within the free-tier cap
        if (!fundedManagers.has(managerId)) {
          await deps.managerXp.credit(ManagerId(managerId), AMPLE_XP_FOR_TESTS);
          fundedManagers.add(managerId);
        }
        const generated = generationPolicy.generate(random, TALENT_POOL_AGE_RANGE);
        await deps.players.save(
          Player.generateFillOnly(
            playerId,
            `E2E Player ${i}`,
            generated.ageInWeeks,
            agingPolicy.stageForAge(generated.ageInWeeks),
            generated.attributes,
            'BR',
            generated.potentialCeiling,
            generated.physicalCeilings,
          ),
        );
        await deps.claimTalentPoolCandidate.execute({
          playerId,
          managerId: ManagerId(managerId),
        });
      }
      const hired = await deps.players.findById(PlayerId('e2e-p1'));
      expect(hired).not.toBeNull();

      // 2. Open the tournament and register every entrant (full draw:
      // no byes, so round 1 is guaranteed to be all real matches).
      await deps.openTournament.execute({
        tournamentId: TOURNAMENT_ID,
        tier: 'challenger',
        surface: 'hard',
        weekScheduled: { season: 1, week: 1 },
        drawSize: DRAW_SIZE,
        entrants: Array.from({ length: PLAYER_COUNT }, (_, i) => ({
          playerId: PlayerId(`e2e-p${i + 1}`),
          seed: i + 1,
        })),
      });

      const opened = await deps.tournaments.findById(TOURNAMENT_ID);
      expect(opened).not.toBeNull();
      expect(opened!.hasStarted).toBe(true);
      expect(opened!.entrants).toHaveLength(PLAYER_COUNT);
      expect(opened!.getRounds()[0].matches).toHaveLength(PLAYER_COUNT / 2);
      expect(opened!.getRounds()[0].matches.every((m) => m.outcome === null)).toBe(true);

      // 3. Simulate: enqueue the real production job on a real queue,
      // let a real Worker process it against real Redis. No handler
      // function is called directly here.
      const job = await queue.add('simulate-due-matches', {});
      const result = await job.waitUntilFinished(queueEvents, 30_000);

      expect(result.failed).toHaveLength(0);
      expect(result.simulated.length).toBe(PLAYER_COUNT / 2); // every round-1 match, in one sweep

      // 4. Confirm Postgres actually holds the recorded outcome.
      const afterSim = await deps.tournaments.findById(TOURNAMENT_ID);
      const decided = afterSim!.getRounds()[0].matches[0];
      expect(decided.outcome).not.toBeNull();
      expect([decided.entrantA, decided.entrantB]).toContain(decided.outcome!.winner);

      // 5. Fetch and validate the replay log the simulation produced —
      // read straight off disk, exactly what the /match-logs/:file
      // route and MatchReplayPlayer component consume in the app.
      const matchId = result.simulated[0];
      const raw = await readFile(join(matchLogDirectory, `${matchId}.json`), 'utf8');
      const log = JSON.parse(raw);

      expect(Array.isArray(log.entries)).toBe(true);
      expect(log.entries.length).toBeGreaterThan(0);
      expect(log.totalDurationSeconds).toBeGreaterThan(0);
      // Every entry lands within the total, and the log is internally
      // consistent (final entry's offset IS the reported duration).
      for (const entry of log.entries) {
        expect(entry.offsetSeconds).toBeLessThanOrEqual(log.totalDurationSeconds);
        expect(['A', 'B']).toContain(entry.wonBy);
      }
      expect(log.entries[log.entries.length - 1].offsetSeconds).toBe(log.totalDurationSeconds);
    },
    60_000,
  );
});
