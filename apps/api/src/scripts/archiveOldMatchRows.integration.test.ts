import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../db/schema';
import { testConnectionString } from '../db/testConnection';
import { archiveOldMatchRows } from '../../scripts/lib/soakEvidence.mjs';

/**
 * A2 — the harness archive must never prune a HUMAN manager's match
 * history. `archiveOldMatchRows` deletes all but the final main-draw
 * round (and every doubles match) of finished tournaments older than ~3
 * weeks, excluding tournaments with entries by the run's tracked players.
 * A human playing alongside the agents is not one of the run's managers,
 * so without the new `protectedManagerIds` parameter their old rounds —
 * and the replays those rounds link to — silently vanished.
 *
 * These cases run against REAL Postgres, because the guard is SQL (a
 * join from entries/entrants/pairs to players.manager_id) that no
 * in-memory fake exercises. The protection is proven load-bearing by
 * running the SAME archive call a second time with no protected
 * managers and watching the round disappear.
 */

const connectionString = testConnectionString();
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

/** S1W1 in absolute weeks is 53; the archive's cutoff is currentAbs - 3,
 * so 60 comfortably puts these tournaments well past the 3-week window. */
const CURRENT_ABS = 60;

const HUMAN_MANAGER = 'human-m1';
const OWNED_TOURNAMENT_IDS = [
  'arch-t-human',
  'arch-t-control',
  'arch-t-doubles-entrant',
  'arch-t-doubles-pair',
];
const OWNED_PLAYER_IDS = ['arch-p-human', 'arch-p-f1', 'arch-p-f2'];

async function seedPlayer(id: string, managerId: string | null): Promise<void> {
  await db.insert(schema.players).values({
    id,
    name: id,
    managerId,
    ageInWeeks: 600,
    stage: 'prime',
    serve: 50,
    forehand: 50,
    backhand: 50,
    volley: 50,
    speed: 50,
    stamina: 50,
    strength: 50,
    consistency: 50,
    clutch: 50,
    affinityClay: 0,
    affinityGrass: 0,
    affinityHard: 0,
    affinityIndoor: 0,
  });
}

async function seedTournament(id: string): Promise<void> {
  await db.insert(schema.tournaments).values({
    id,
    name: id,
    tier: 'futures',
    surface: 'clay',
    seasonScheduled: 1,
    weekScheduled: 1,
    drawSize: 16,
    hasStarted: true,
  });
}

/** Round 1 (archivable) + round 2 (the kept final), both decided. */
async function seedDecidedSingles(tournamentId: string, a: string, b: string): Promise<void> {
  const sets = [{ winnerGames: 6, loserGames: 0 }];
  await db.insert(schema.tournamentMatches).values([
    { tournamentId, draw: 'main', roundNumber: 1, matchIndex: 0, entrantA: a, entrantB: b, winnerId: a, loserId: b, setScores: sets },
    { tournamentId, draw: 'main', roundNumber: 2, matchIndex: 0, entrantA: a, entrantB: b, winnerId: a, loserId: b, setScores: sets },
  ]);
}

async function seedDecidedDoubles(tournamentId: string): Promise<void> {
  const sets = [{ winnerGames: 6, loserGames: 0 }];
  await db.insert(schema.tournamentDoublesMatches).values([
    { tournamentId, draw: 'main', roundNumber: 1, matchIndex: 0, entrantA: 't1-d0', entrantB: 't1-d1', winnerId: 't1-d0', loserId: 't1-d1', setScores: sets },
    { tournamentId, draw: 'main', roundNumber: 2, matchIndex: 0, entrantA: 't1-d0', entrantB: 't1-d2', winnerId: 't1-d0', loserId: 't1-d2', setScores: sets },
  ]);
}

async function singlesRounds(tournamentId: string): Promise<number[]> {
  const rows = await pool.query<{ round_number: number }>(
    'SELECT round_number FROM tournament_matches WHERE tournament_id = $1 ORDER BY round_number',
    [tournamentId],
  );
  return rows.rows.map((r) => r.round_number);
}

async function doublesMatchCount(tournamentId: string): Promise<number> {
  const rows = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM tournament_doubles_matches WHERE tournament_id = $1',
    [tournamentId],
  );
  return Number(rows.rows[0].n);
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
});

beforeEach(async () => {
  // Only this file's own rows: other integration files run sequentially
  // and may leave unrelated tournaments behind, so asserting on absolute
  // deletion counts would be flaky. Deleting the tournament cascades to
  // entries, matches, doubles rows and pairs.
  for (const id of OWNED_TOURNAMENT_IDS) {
    await pool.query('DELETE FROM tournaments WHERE id = $1', [id]);
  }
  for (const id of OWNED_PLAYER_IDS) {
    await pool.query('DELETE FROM players WHERE id = $1', [id]);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('archiveOldMatchRows protects a configured human manager', () => {
  it('keeps a human-owned player\u2019s old round; the same tournament loses it with no protection', async () => {
    await seedPlayer('arch-p-human', HUMAN_MANAGER);
    await seedPlayer('arch-p-f1', null);
    await seedPlayer('arch-p-f2', null);

    await seedTournament('arch-t-human');
    await db.insert(schema.tournamentEntries).values({ tournamentId: 'arch-t-human', playerId: 'arch-p-human' });
    await seedDecidedSingles('arch-t-human', 'arch-p-human', 'arch-p-f1');

    await seedTournament('arch-t-control');
    await db.insert(schema.tournamentEntries).values({ tournamentId: 'arch-t-control', playerId: 'arch-p-f2' });
    await seedDecidedSingles('arch-t-control', 'arch-p-f1', 'arch-p-f2');

    const result = await archiveOldMatchRows(pool, CURRENT_ABS, [], [HUMAN_MANAGER]);
    expect(result.mainDeleted).toBeGreaterThanOrEqual(1);

    // The human's tournament keeps BOTH rounds (final + the old round)...
    expect(await singlesRounds('arch-t-human')).toEqual([1, 2]);
    // ...while the control tournament keeps only the final.
    expect(await singlesRounds('arch-t-control')).toEqual([2]);

    // Proof the protection is what saved it: the same call without any
    // protected managers archives the human's old round too.
    await archiveOldMatchRows(pool, CURRENT_ABS, [], []);
    expect(await singlesRounds('arch-t-human')).toEqual([2]);
  });

  it('keeps a tournament where a human-owned player is a doubles ENTRANT', async () => {
    await seedPlayer('arch-p-human', HUMAN_MANAGER);
    await seedPlayer('arch-p-f1', null);

    await seedTournament('arch-t-doubles-entrant');
    await db.insert(schema.tournamentEntries).values({ tournamentId: 'arch-t-doubles-entrant', playerId: 'arch-p-f1' });
    await seedDecidedSingles('arch-t-doubles-entrant', 'arch-p-f1', 'arch-p-human');
    await db.insert(schema.tournamentDoublesEntrants).values({ tournamentId: 'arch-t-doubles-entrant', playerId: 'arch-p-human' });
    await seedDecidedDoubles('arch-t-doubles-entrant');

    await archiveOldMatchRows(pool, CURRENT_ABS, [], [HUMAN_MANAGER]);

    expect(await doublesMatchCount('arch-t-doubles-entrant')).toBe(2);
    expect(await singlesRounds('arch-t-doubles-entrant')).toEqual([1, 2]);

    // Without protection the doubles bracket is archived away entirely.
    await archiveOldMatchRows(pool, CURRENT_ABS, [], []);
    expect(await doublesMatchCount('arch-t-doubles-entrant')).toBe(0);
  });

  it('keeps a tournament where a human-owned player is a formed doubles PAIR member (padding case)', async () => {
    await seedPlayer('arch-p-human', HUMAN_MANAGER);
    await seedPlayer('arch-p-f1', null);
    await seedPlayer('arch-p-f2', null);

    await seedTournament('arch-t-doubles-pair');
    await db.insert(schema.tournamentEntries).values({ tournamentId: 'arch-t-doubles-pair', playerId: 'arch-p-f1' });
    await seedDecidedSingles('arch-t-doubles-pair', 'arch-p-f1', 'arch-p-f2');
    // A pair member with NO doubles_entrants row — exactly how a
    // filler-padded pair is formed (the padding never registers an
    // entrant row).
    await db.insert(schema.tournamentDoublesPairs).values({
      tournamentId: 'arch-t-doubles-pair',
      pairId: 't1-d0',
      playerA: 'arch-p-human',
      playerB: 'arch-p-f1',
    });
    await seedDecidedDoubles('arch-t-doubles-pair');

    await archiveOldMatchRows(pool, CURRENT_ABS, [], [HUMAN_MANAGER]);

    expect(await doublesMatchCount('arch-t-doubles-pair')).toBe(2);

    await archiveOldMatchRows(pool, CURRENT_ABS, [], []);
    expect(await doublesMatchCount('arch-t-doubles-pair')).toBe(0);
  });
});
