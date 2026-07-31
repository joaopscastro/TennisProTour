import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';
import * as schema from '../../../db/schema';
import { buildDependencies } from '../../../composition';
import { buildApp } from '../../../app';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

let app: FastifyInstance;
let matchLogDirectory: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  matchLogDirectory = await mkdtemp(join(tmpdir(), 'api-match-logs-'));
  const deps = buildDependencies({
    db,
    matchLogDirectory,
    logEvent: () => {},
  });
  app = buildApp({ deps, logger: false });
  await app.ready();
});

beforeEach(async () => {
  await db.delete(schema.tournamentMatches);
  await db.delete(schema.tournamentEntries);
  await db.delete(schema.tournaments);
  await db.delete(schema.players);
});

afterAll(async () => {
  await app.close();
  await rm(matchLogDirectory, { recursive: true, force: true });
  await pool.end();
});

async function hirePlayer(id: string, managerId: string): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/players',
    payload: { playerId: id, name: `Player ${id}`, managerId, startingAgeInWeeks: 20 * 52 },
  });
  return response.statusCode;
}

describe('API', () => {
  it('serves the health check', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('hires a player and reads it back', async () => {
    expect(await hirePlayer('p1', 'm1')).toBe(201);

    const response = await app.inject({ method: 'GET', url: '/players/p1' });
    expect(response.statusCode).toBe(200);
    const dto = response.json();
    expect(dto.id).toBe('p1');
    expect(dto.name).toBe('Player p1');
    expect(dto.stage).toBe('youth');
    expect(dto.attributes.technical.serve).toBe(30);
    expect(dto.attributes.surfaceAffinities.clay).toBe(20);
  });

  it('enforces the roster cap through the use case (409, not a controller rule)', async () => {
    // Each manager gets 3 slots from the composition root's stub.
    expect(await hirePlayer('p1', 'm1')).toBe(201);
    expect(await hirePlayer('p2', 'm1')).toBe(201);
    expect(await hirePlayer('p3', 'm1')).toBe(201);
    expect(await hirePlayer('p4', 'm1')).toBe(409);
  });

  it('404s on a missing player and rejects an invalid hire body', async () => {
    expect((await app.inject({ method: 'GET', url: '/players/nope' })).statusCode).toBe(404);

    const invalid = await app.inject({
      method: 'POST',
      url: '/players',
      payload: { playerId: 'p1', name: 'X' }, // managerId + age missing
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('opens a tournament, simulates a match, and exposes the outcome and replay URL', async () => {
    // 16 players across distinct managers (roster cap is 3 per manager).
    for (let i = 1; i <= 16; i++) {
      expect(await hirePlayer(`p${i}`, `m${Math.ceil(i / 3)}`)).toBe(201);
    }

    const opened = await app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        tournamentId: 't1',
        tier: 'challenger',
        surface: 'clay',
        weekScheduled: { season: 1, week: 5 },
        drawSize: 16,
        entrants: Array.from({ length: 16 }, (_, i) => ({ playerId: `p${i + 1}`, seed: i + 1 })),
      },
    });
    expect(opened.statusCode).toBe(201);
    const openedDto = opened.json();
    expect(openedDto.hasStarted).toBe(true);
    expect(openedDto.rounds).toHaveLength(1);
    expect(openedDto.rounds[0].matches).toHaveLength(8);

    const simulated = await app.inject({ method: 'POST', url: '/tournaments/t1/matches/1/0/simulate' });
    expect(simulated.statusCode).toBe(200);
    const { matchId, replayUrl } = simulated.json();
    expect(matchId).toBe('t1-r1-m0');
    expect(replayUrl).toContain('t1-r1-m0.json');

    const fetched = await app.inject({ method: 'GET', url: '/tournaments/t1' });
    expect(fetched.statusCode).toBe(200);
    const dto = fetched.json();
    const match = dto.rounds[0].matches[0];
    expect(match.outcome).not.toBeNull();
    expect([match.entrantA, match.entrantB]).toContain(match.outcome.winner);

    // Re-simulating the same slot must fail (already-decided match), not overwrite.
    const again = await app.inject({ method: 'POST', url: '/tournaments/t1/matches/1/0/simulate' });
    expect(again.statusCode).toBe(409);
  });

  it('404s when simulating a match in a missing tournament', async () => {
    const response = await app.inject({ method: 'POST', url: '/tournaments/ghost/matches/1/0/simulate' });
    expect(response.statusCode).toBe(404);
  });
});
