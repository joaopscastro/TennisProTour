import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { TournamentId, WorldId } from '@tennis-manager/domain';
import * as schema from '../db/schema';
import { testConnectionString } from '../db/testConnection';
import { buildDependencies, Dependencies } from '../composition';
import { bootstrapWorld, DEMO_TOURNAMENT_ID } from './bootstrapTestWorld';

// Auth fails CLOSED (unset AUTH_MODE defaults to clerk), so opt into the
// development adapter explicitly — same as every other api integration
// suite. This test never makes an HTTP request, but buildDependencies
// constructs the auth adapter regardless.
process.env.AUTH_MODE = 'development';

const connectionString = testConnectionString();
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

const WORLD_ID = WorldId('main');

let deps: Dependencies;
let matchLogDirectory: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  matchLogDirectory = await mkdtemp(join(tmpdir(), 'bootstrap-test-logs-'));
});

beforeEach(async () => {
  // Child tables first (FKs), then parents — same order every other api
  // integration suite uses. game_worlds is wiped too so bootstrap's
  // phase 0 genuinely exercises the "world absent" path.
  await db.delete(schema.weeklyEntryClaims);
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
  await db.delete(schema.managerEntitlements);
  await db.delete(schema.managerProgression);
  await db.delete(schema.notificationDeliveries);
  await db.delete(schema.managerNotificationStates);
  await db.delete(schema.managers);
  await db.delete(schema.gameWorlds);

  deps = buildDependencies({
    db,
    matchLogDirectory,
    logEvent: () => {},
  });
});

afterAll(async () => {
  await rm(matchLogDirectory, { recursive: true, force: true });
  await pool.end();
});

describe('bootstrapWorld', () => {
  it('turns an empty world playable, writes NO seed-* rows, and is idempotent on re-run', async () => {
    const first = await bootstrapWorld(deps, WORLD_ID, () => {});

    // Phase 1: free agents exist to sign and pad draws.
    expect(first.fillersGenerated).toBeGreaterThan(0);
    expect(first.freeAgents).toBeGreaterThan(0);

    // Phase 0: the world itself now exists.
    const world = await deps.worlds.findById(WORLD_ID);
    expect(world).not.toBeNull();

    // Phase 3: an OPEN, current-week SENIOR tournament exists.
    const open = await deps.tournaments.findOpenForRegistration();
    const currentWeekSenior = open.filter(
      (t) =>
        t.ageBand === null &&
        t.weekScheduled.season === world!.currentWeek.season &&
        t.weekScheduled.week === world!.currentWeek.week,
    );
    expect(currentWeekSenior.length).toBeGreaterThan(0);
    expect(first.currentWeekSlateOpened).toBeGreaterThan(0);

    // Phase 2: the fixed demo draw exists AND has been seeded.
    const demo = await deps.tournaments.findById(TournamentId(DEMO_TOURNAMENT_ID));
    expect(demo).not.toBeNull();
    expect(demo!.hasStarted).toBe(true);

    // Hard requirement: no seed-* manager or tournament rows.
    const seedManagers = await db
      .select({ id: schema.managers.id })
      .from(schema.managers)
      .where(like(schema.managers.id, 'seed-%'));
    expect(seedManagers).toHaveLength(0);
    const seedTournaments = await db
      .select({ id: schema.tournaments.id })
      .from(schema.tournaments)
      .where(like(schema.tournaments.id, 'seed-%'));
    expect(seedTournaments).toHaveLength(0);

    // ---- Re-run must be a genuine no-op ----
    const tournamentsAfterFirstRun = first.totalTournaments;
    const freeAgentsAfterFirstRun = first.freeAgents;

    const second = await bootstrapWorld(deps, WORLD_ID, () => {});

    expect(second.fillersGenerated).toBe(0);
    expect(second.currentWeekSlateOpened).toBe(0);
    expect(second.futureWeeksOpened).toBe(0);
    expect(second.demoOpened).toBe(false);
    expect(second.demoStarted).toBe(false);
    expect(second.totalTournaments).toBe(tournamentsAfterFirstRun);
    expect(second.freeAgents).toBe(freeAgentsAfterFirstRun);
    // The bootstrap makes hundreds of sequential writes (fillers + a full
    // season's slate) against real Postgres, so give it a generous
    // timeout well above vitest's 5s default.
  }, 120_000);
});
