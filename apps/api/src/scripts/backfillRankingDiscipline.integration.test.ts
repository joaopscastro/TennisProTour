/**
 * Real-Postgres coverage for the ranking-discipline backfill: the whole
 * point of this script is what it does to real rows and real peak
 * tables, so a fake would prove nothing. Seeds one tournament with one
 * decided singles match and one decided doubles match (four doubles
 * ledger rows, one singles row), runs the backfill for real, and asserts:
 *   - exactly the four doubles rows are reclassified (and the singles
 *     row is untouched);
 *   - `peak_rankings` is corrected (the seeded inflated value is
 *     lowered) and `doubles_peak_rankings` gains a real non-zero peak;
 *   - an immediate second `--apply` performs ZERO updates (idempotent);
 *   - a dry run writes nothing at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import {
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  Skill,
  SurfaceAffinities,
} from '@tennis-manager/domain';
import * as schema from '../db/schema';
import { testConnectionString } from '../db/testConnection';
import { DrizzlePlayerRepository } from '../adapters/outbound/DrizzlePlayerRepository';
import { runBackfill } from './backfillRankingDiscipline';

const connectionString = testConnectionString();
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
});

beforeEach(async () => {
  await db.delete(schema.weeklyEntryClaims);
  await db.delete(schema.rankingLedger);
  await db.delete(schema.titles);
  await db.delete(schema.peakRankings);
  await db.delete(schema.tournamentMatches);
  await db.delete(schema.tournamentDoublesMatches);
  await db.delete(schema.tournamentDoublesPairs);
  await db.delete(schema.tournamentDoublesEntrants);
  await db.delete(schema.tournamentEntries);
  await db.delete(schema.tournaments);
  await db.delete(schema.doublesTitles);
  await db.delete(schema.doublesPeakRankings);
  await db.delete(schema.players);
});

afterAll(async () => {
  await pool.end();
});

async function seed(): Promise<void> {
  const players = new DrizzlePlayerRepository(db);
  const attributes = new PlayerAttributes({
    technical: { serve: Skill.of(30), forehand: Skill.of(31), backhand: Skill.of(32), volley: Skill.of(33) },
    physical: { speed: Skill.of(34), stamina: Skill.of(35), strength: Skill.of(36) },
    mental: { consistency: Skill.of(37), clutch: Skill.of(38) },
    surfaceAffinities: SurfaceAffinities.initial().trainedOn('hard', 15),
  });
  for (const id of ['p1', 'p2', 'p3', 'p4']) {
    await players.save(Player.hire(PlayerId(id), `Player ${id}`, 25 * 52, attributes, ManagerId('m1')));
  }
  await db.insert(schema.tournaments).values({
    id: 't-backfill',
    name: 'Backfill Test Challenger',
    tier: 'challenger',
    surface: 'hard',
    seasonScheduled: 1,
    weekScheduled: 1,
    drawSize: 16,
    hasStarted: true,
    version: 1,
  });
  // One decided singles match: p3 beats p1 in round 1 (p1's singles row is 0).
  await db.insert(schema.tournamentMatches).values({
    tournamentId: 't-backfill',
    draw: 'main',
    roundNumber: 1,
    matchIndex: 0,
    entrantA: 'p3',
    entrantB: 'p1',
    winnerId: 'p3',
    loserId: 'p1',
    setScores: [{ winnerGames: 6, loserGames: 2 }],
  });
  // One decided doubles match: entrantA pair d0 loses to entrantB pair d1.
  // The historical slot-based award still paid d0's players the winner
  // value (90) and d1's players the loser value (0) — the classifier
  // reproduces that.
  await db.insert(schema.tournamentDoublesPairs).values([
    { tournamentId: 't-backfill', pairId: 'd0', playerA: 'p1', playerB: 'p2', draw: 'main' },
    { tournamentId: 't-backfill', pairId: 'd1', playerA: 'p3', playerB: 'p4', draw: 'main' },
  ]);
  await db.insert(schema.tournamentDoublesMatches).values({
    tournamentId: 't-backfill',
    draw: 'main',
    roundNumber: 1,
    matchIndex: 0,
    entrantA: 'd0',
    entrantB: 'd1',
    winnerId: 'd1',
    loserId: 'd0',
    setScores: [{ winnerGames: 6, loserGames: 3 }],
  });
  // The ledger as it actually was written pre-column: no discipline.
  await db.insert(schema.rankingLedger).values([
    { id: 'l-p1-singles', playerId: 'p1', tournamentId: 't-backfill', tier: 'challenger', ageBand: null, points: 0, seasonEarned: 1, weekEarned: 1 },
    { id: 'l-p1-doubles', playerId: 'p1', tournamentId: 't-backfill', tier: 'challenger', ageBand: null, points: 90, seasonEarned: 1, weekEarned: 1 },
    { id: 'l-p2-doubles', playerId: 'p2', tournamentId: 't-backfill', tier: 'challenger', ageBand: null, points: 90, seasonEarned: 1, weekEarned: 1 },
    { id: 'l-p3-doubles', playerId: 'p3', tournamentId: 't-backfill', tier: 'challenger', ageBand: null, points: 0, seasonEarned: 1, weekEarned: 1 },
    { id: 'l-p4-doubles', playerId: 'p4', tournamentId: 't-backfill', tier: 'challenger', ageBand: null, points: 0, seasonEarned: 1, weekEarned: 1 },
  ]);
  // An inflated singles peak (what the old discipline-blind update wrote:
  // 0 + 90 summed into the singles total) and no doubles peak at all.
  await db.insert(schema.peakRankings).values({
    playerId: 'p1',
    band: 'senior',
    peakPoints: 90,
    peakAsOfSeason: 1,
    peakAsOfWeek: 1,
  });
}

async function disciplineOf(id: string): Promise<string> {
  const rows = await db.select({ discipline: schema.rankingLedger.discipline }).from(schema.rankingLedger).where(eq(schema.rankingLedger.id, id));
  return rows[0].discipline;
}

describe('backfillRankingDiscipline (real Postgres)', () => {
  it('classifies the four doubles rows, lowers the inflated singles peak, creates the doubles peak, and is idempotent', async () => {
    await seed();
    const lines: string[] = [];

    // DRY RUN first: nothing may change.
    const dry = await runBackfill(db, 'test', false, (line) => lines.push(line));
    expect(dry.classification.setDoubles).toBe(4);
    expect(dry.classification.unresolved).toHaveLength(0);
    expect(dry.rowsUpdated).toBe(0);
    expect(await disciplineOf('l-p1-doubles')).toBe('singles'); // untouched by a dry run
    expect(await db.select().from(schema.doublesPeakRankings)).toHaveLength(0);

    // APPLY.
    const applied = await runBackfill(db, 'test', true, (line) => lines.push(line));
    expect(applied.rowsUpdated).toBe(4);
    expect(applied.peakDiff.lower).toBe(1); // p1's 90 → 0

    expect(await disciplineOf('l-p1-singles')).toBe('singles');
    expect(await disciplineOf('l-p1-doubles')).toBe('doubles');
    expect(await disciplineOf('l-p2-doubles')).toBe('doubles');
    expect(await disciplineOf('l-p3-doubles')).toBe('doubles');
    expect(await disciplineOf('l-p4-doubles')).toBe('doubles');

    const peak = (await db.select().from(schema.peakRankings).where(eq(schema.peakRankings.playerId, 'p1')))[0];
    expect(peak.peakPoints).toBe(0); // 0 singles + 0 from the R1 loss — the doubles 90 is gone

    const doublesPeaks = await db.select().from(schema.doublesPeakRankings);
    const p2DoublePeak = doublesPeaks.find((p) => p.playerId === 'p2');
    expect(p2DoublePeak?.peakPoints).toBe(90);

    // SECOND APPLY: zero updates, zero peak writes.
    const second = await runBackfill(db, 'test', true, () => {});
    expect(second.rowsUpdated).toBe(0);
    expect(second.peakDiff).toEqual({ create: 0, raise: 0, lower: 0, unchanged: second.peakDiff.unchanged, remove: 0 });
    expect(second.doublesPeakDiff).toEqual({
      create: 0,
      raise: 0,
      lower: 0,
      unchanged: second.doublesPeakDiff.unchanged,
      remove: 0,
    });
  });
});
