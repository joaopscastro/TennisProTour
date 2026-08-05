import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';
import {
  PlayerAttributes,
  Skill,
  StandardRankingPointsTable,
  SurfaceAffinities,
  TalentPoolCandidate,
  TalentPoolCandidateId,
} from '@tennis-manager/domain';
import * as schema from '../../../db/schema';
import { buildDependencies, Dependencies } from '../../../composition';
import { buildApp } from '../../../app';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

let app: FastifyInstance;
let deps: Dependencies;
let matchLogDirectory: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  // RankPositionQuery reads the "main" world's current week to decide
  // which ranking-ledger entries fall inside the rolling 52-week
  // window (see composition.ts's WORLD_ID default). Seeded comfortably
  // past every test tournament's weekScheduled so freshly-earned
  // points always land inside the window, not before it.
  await db.insert(schema.gameWorlds).values({ id: 'main', season: 1, week: 52 }).onConflictDoNothing();
  matchLogDirectory = await mkdtemp(join(tmpdir(), 'api-match-logs-'));
  deps = buildDependencies({
    db,
    matchLogDirectory,
    logEvent: () => {},
  });
  app = buildApp({ deps, matchLogDirectory, logger: false });
  await app.ready();
});

beforeEach(async () => {
  // ranking_ledger has FKs to both players and tournaments — must go
  // before either.
  await db.delete(schema.rankingLedger);
  await db.delete(schema.tournamentMatches);
  await db.delete(schema.tournamentEntries);
  await db.delete(schema.tournaments);
  await db.delete(schema.players);
  await db.delete(schema.talentPoolCandidates);
  await db.delete(schema.managerEntitlements);
});

afterAll(async () => {
  await app.close();
  await rm(matchLogDirectory, { recursive: true, force: true });
  await pool.end();
});

/** Fixed baseline attributes (no rarity roll) — the pool/claim HTTP
 * path is exercised for real via app.inject(), but generation itself
 * is bypassed here (a candidate is seeded directly at a known
 * attribute baseline) so downstream assertions can check exact,
 * predictable values instead of asserting against whatever
 * StandardPlayerGenerationPolicy happens to roll. Real generation is
 * covered by PlayerGenerationPolicy's own test suite. */
function fixedAttributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

/** Seeds a talent pool candidate at a fixed id/attribute baseline,
 * then claims it through the real HTTP endpoint
 * (POST /talent-pool/:id/claim) — the candidate's id becomes the
 * resulting player's id, so callers can keep using the same `p1`-style
 * ids the old direct-hire helper used. */
async function hirePlayer(id: string, managerId: string): Promise<number> {
  await deps.talentPoolCandidates.save(
    TalentPoolCandidate.generate(
      TalentPoolCandidateId(id),
      { name: `Player ${id}`, nationality: 'BR', tier: 'common', attributes: fixedAttributes(30), potentialCeiling: 100, potentialTier: 'promising' },
      { season: 1, week: 1 },
    ),
  );
  const response = await app.inject({
    method: 'POST',
    url: `/talent-pool/${id}/claim`,
    payload: { managerId },
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

  it('enforces the free-tier roster cap of 2 through BillingPort (409, not a controller rule)', async () => {
    expect(await hirePlayer('p1', 'm1')).toBe(201);
    expect(await hirePlayer('p2', 'm1')).toBe(201);
    expect(await hirePlayer('p3', 'm1')).toBe(409);
  });

  it('404s on a missing player, and rejects an invalid claim/custom-player body before touching any use case', async () => {
    expect((await app.inject({ method: 'GET', url: '/players/nope' })).statusCode).toBe(404);

    const invalidClaim = await app.inject({
      method: 'POST',
      url: '/talent-pool/does-not-matter/claim',
      payload: {}, // managerId missing
    });
    expect(invalidClaim.statusCode).toBe(400);

    const invalidCustom = await app.inject({
      method: 'POST',
      url: '/players/custom',
      payload: { managerId: 'm1', name: 'X' }, // nationality missing
    });
    expect(invalidCustom.statusCode).toBe(400);
  });

  it('claiming a talent pool candidate that does not exist is a 409, not a 404 (it is a conflict over availability, not a missing resource)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/talent-pool/does-not-exist/claim',
      payload: { managerId: 'm1' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('opens a tournament, simulates a match, and exposes the outcome and replay URL', async () => {
    // 16 players across distinct managers (free roster cap is 2 per manager).
    for (let i = 1; i <= 16; i++) {
      expect(await hirePlayer(`p${i}`, `m${Math.ceil(i / 2)}`)).toBe(201);
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

    // The replay blob is served by the dev match-log route, immutable-cached.
    const replay = await app.inject({ method: 'GET', url: '/match-logs/t1-r1-m0.json' });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['cache-control']).toContain('immutable');
    const log = replay.json();
    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.totalDurationSeconds).toBeGreaterThan(0);
  });

  it('lists a manager roster (empty roster is 200 [], missing replay is 404)', async () => {
    expect((await app.inject({ method: 'GET', url: '/managers/m9/players' })).json()).toEqual([]);

    await hirePlayer('p1', 'm1');
    await hirePlayer('p2', 'm1');
    await hirePlayer('p3', 'm2');

    const roster = (await app.inject({ method: 'GET', url: '/managers/m1/players' })).json();
    expect(roster).toHaveLength(2);
    expect(roster.map((p: { id: string }) => p.id).sort()).toEqual(['p1', 'p2']);

    expect((await app.inject({ method: 'GET', url: '/match-logs/ghost.json' })).statusCode).toBe(404);
  });

  it('404s when simulating a match in a missing tournament', async () => {
    const response = await app.inject({ method: 'POST', url: '/tournaments/ghost/matches/1/0/simulate' });
    expect(response.statusCode).toBe(404);
  });

  it('awards ranking points per PLAYER through a full tournament, matching StandardRankingPointsTable', async () => {
    // 8 managers, 2 players each — irrelevant to ranking now (it's
    // per-player), but kept so the roster caps stay realistic.
    const managerOf = (playerIndex: number) => `rm${Math.ceil(playerIndex / 2)}`;
    for (let i = 1; i <= 16; i++) {
      expect(await hirePlayer(`rp${i}`, managerOf(i))).toBe(201);
    }

    const opened = await app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        tournamentId: 'rt1',
        tier: 'challenger',
        surface: 'clay',
        weekScheduled: { season: 1, week: 5 },
        drawSize: 16,
        entrants: Array.from({ length: 16 }, (_, i) => ({ playerId: `rp${i + 1}`, seed: i + 1 })),
      },
    });
    expect(opened.statusCode).toBe(201);

    // The real StatisticalMatchSimulator is non-deterministic, so who
    // wins which match can't be predicted up front — only the round
    // structure (8/4/2/1 matches for a 16-draw) is known in advance;
    // actual winners are discovered afterward from the tournament DTO.
    const roundMatchCounts = [8, 4, 2, 1];
    for (let roundNumber = 1; roundNumber <= roundMatchCounts.length; roundNumber++) {
      for (let matchIndex = 0; matchIndex < roundMatchCounts[roundNumber - 1]; matchIndex++) {
        const response = await app.inject({
          method: 'POST',
          url: `/tournaments/rt1/matches/${roundNumber}/${matchIndex}/simulate`,
        });
        expect(response.statusCode).toBe(200);
      }
    }

    const finished = await app.inject({ method: 'GET', url: '/tournaments/rt1' });
    expect(finished.statusCode).toBe(200);
    const dto = finished.json();

    const roundsWonByPlayer = new Map<string, number>();
    for (const round of dto.rounds) {
      for (const match of round.matches) {
        const winner: string = match.outcome.winner;
        roundsWonByPlayer.set(winner, (roundsWonByPlayer.get(winner) ?? 0) + 1);
      }
    }

    const rankingPointsTable = new StandardRankingPointsTable();
    for (let i = 1; i <= 16; i++) {
      const playerId = `rp${i}`;
      const expectedPoints = rankingPointsTable.pointsFor('challenger', roundsWonByPlayer.get(playerId) ?? 0);

      const rankingResponse = await app.inject({ method: 'GET', url: `/players/${playerId}/ranking` });
      expect(rankingResponse.statusCode).toBe(200);
      const ranking = rankingResponse.json();
      expect(ranking.playerId).toBe(playerId);
      expect(ranking.totalPoints).toBeCloseTo(expectedPoints, 6);
    }

    // Rank position is derived, not stored: the champion (4 rounds
    // won) earns the most points of anyone in this single tournament,
    // so they must be #1.
    const championId = [...roundsWonByPlayer.entries()].find(([, rounds]) => rounds === 4)?.[0];
    expect(championId).toBeDefined();
    const championRanking = await app.inject({ method: 'GET', url: `/players/${championId}/ranking` });
    expect(championRanking.json().rank).toBe(1);
  });

  it("defaults a player's ranking to unranked (rank: null, 0 points) when they haven't earned any yet", async () => {
    const response = await app.inject({ method: 'GET', url: '/players/never-earned-anything/ranking' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ playerId: 'never-earned-anything', totalPoints: 0, rank: null });
  });

  it('serves the roster-dashboard read model with rank, overall, and surfaces per player', async () => {
    await hirePlayer('dp1', 'dm1');
    await hirePlayer('dp2', 'dm1');

    const response = await app.inject({ method: 'GET', url: '/managers/dm1/roster-dashboard' });
    expect(response.statusCode).toBe(200);
    const entries = response.json();
    expect(entries).toHaveLength(2);
    expect(entries.map((e: { id: string }) => e.id).sort()).toEqual(['dp1', 'dp2']);
    for (const entry of entries) {
      expect(entry.rank).toBeNull(); // hasn't played a match yet
      expect(entry.overall).toBe(30);
      expect(entry.lastResult).toBeNull();
      expect(entry.surfaceAffinities).toEqual({ clay: 20, grass: 20, hard: 20, indoor: 20 });
    }
  });

  it("reports a manager's entitlement tier", async () => {
    const response = await app.inject({ method: 'GET', url: '/managers/some-free-manager/entitlement' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ managerId: 'some-free-manager', tier: 'free', customPlayerCredits: 0 });
  });

  it('lists available talent pool candidates with a coarse potentialTier, and NEVER leaks the hidden potentialCeiling', async () => {
    await deps.talentPoolCandidates.save(
      TalentPoolCandidate.generate(
        TalentPoolCandidateId('tp1'),
        {
          name: 'Pool Player',
          nationality: 'ES',
          tier: 'strong',
          attributes: fixedAttributes(50),
          potentialCeiling: 91, // the real hidden number — must never appear in any response below
          potentialTier: 'elite',
        },
        { season: 1, week: 1 },
      ),
    );

    const listed = await app.inject({ method: 'GET', url: '/talent-pool' });
    expect(listed.statusCode).toBe(200);
    const candidates = listed.json();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: 'tp1', name: 'Pool Player', nationality: 'ES', tier: 'strong', potentialTier: 'elite' });
    expect(candidates[0].attributes.technical.serve).toBe(50); // current attributes stay precise, unfuzzed
    expect(listed.body).not.toContain('potentialCeiling');
    expect(listed.body).not.toContain('91'); // the real ceiling value itself, nowhere in the payload

    const claimed = await app.inject({ method: 'POST', url: '/talent-pool/tp1/claim', payload: { managerId: 'm1' } });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json().name).toBe('Pool Player');
    expect(claimed.body).not.toContain('potentialCeiling'); // claiming hands back a player DTO — same rule applies
    expect(claimed.body).not.toContain('91');

    expect((await app.inject({ method: 'GET', url: '/talent-pool' })).json()).toEqual([]);

    // A second claim attempt on the now-claimed candidate is a conflict.
    const secondClaim = await app.inject({ method: 'POST', url: '/talent-pool/tp1/claim', payload: { managerId: 'm2' } });
    expect(secondClaim.statusCode).toBe(409);
  });

  it('rejects creating a custom player for a non-Pro manager', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/players/custom',
      payload: { managerId: 'free-manager', name: 'Custom Kid', nationality: 'FR' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('creates a custom player for a Pro manager with credits, spending exactly one, using generated (not manager-chosen) attributes', async () => {
    await db
      .insert(schema.managerEntitlements)
      .values({ managerId: 'pro-manager', status: 'active', customPlayerCredits: 2 });

    const created = await app.inject({
      method: 'POST',
      url: '/players/custom',
      payload: { managerId: 'pro-manager', name: 'Custom Kid', nationality: 'FR' },
    });
    expect(created.statusCode).toBe(201);
    const dto = created.json();
    expect(dto.name).toBe('Custom Kid');
    expect(dto.nationality).toBe('FR');
    expect(dto.managerId).toBe('pro-manager');
    // Real StandardPlayerGenerationPolicy rolled these — not the fixed
    // 30 baseline the talent-pool test helper above uses, and not
    // caller-supplied — just asserting they're valid rolled skills.
    expect(dto.attributes.technical.serve).toBeGreaterThanOrEqual(0);
    expect(dto.attributes.technical.serve).toBeLessThanOrEqual(100);

    const entitlement = await app.inject({ method: 'GET', url: '/managers/pro-manager/entitlement' });
    expect(entitlement.json().customPlayerCredits).toBe(1); // spent exactly one of the two granted

    // A second and third create: the second still has a credit, the
    // third has none left.
    const second = await app.inject({
      method: 'POST',
      url: '/players/custom',
      payload: { managerId: 'pro-manager', name: 'Second Kid', nationality: 'FR' },
    });
    expect(second.statusCode).toBe(201);

    const third = await app.inject({
      method: 'POST',
      url: '/players/custom',
      payload: { managerId: 'pro-manager', name: 'Third Kid', nationality: 'FR' },
    });
    expect(third.statusCode).toBe(409);
  });
});
