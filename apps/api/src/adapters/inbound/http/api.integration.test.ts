import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';
import {
  BracketGenerator,
  DoublesPair,
  GameWeek,
  GameWorld,
  ManagerId,
  MatchId,
  MatchParticipant,
  MatchSimulator,
  PairId,
  Player,
  PlayerAgingService,
  PlayerAttributes,
  PlayerId,
  qualifierSlotsFor,
  qualifyingDrawSizeFor,
  SimulatedMatch,
  Skill,
  StandardAgingPolicy,
  StandardDoublesPairPolicy,
  StandardManagerLadderPolicy,
  StandardManagerXpPolicy,
  StandardPlayerDevelopmentPolicy,
  StandardRankingPointsTable,
  Surface,
  SurfaceAffinities,
  Tournament,
  TournamentId,
  wildCardSlotsFor,
  WorldId,
} from '@tennis-manager/domain';
import {
  ConcurrentModificationError,
  RegisterEntrantUseCase,
  SimulateDoublesMatchUseCase,
  TournamentRepository,
} from '@tennis-manager/application';
import * as schema from '../../../db/schema';
import { testConnectionString } from '../../../db/testConnection';
import { buildDependencies, Dependencies } from '../../../composition';
import { buildApp } from '../../../app';
import { DrizzleDoublesTitleRepository } from '../../outbound/DrizzleDoublesTitleRepository';
import { DrizzleDoublesPeakRankingRepository } from '../../outbound/DrizzleDoublesPeakRankingRepository';
// The pure agent-harness digest mappers — imported through a small
// digestFeed.d.mts declaration so this suite exercises the EXACT
// production mapping the season harness uses, not a reimplementation.
import { compactDoublesTitles, compactLastResults, compactShop } from '../../../../scripts/lib/digestFeed.mjs';

const connectionString = testConnectionString();
process.env.INTERNAL_ADMIN_TOKEN ??= 'test-admin';
// Auth fails CLOSED when AUTH_MODE is unset (defaults to clerk), so the
// suite must opt into the development adapter explicitly to keep using
// the x-dev-manager-id header.
process.env.AUTH_MODE = 'development';

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
  // Upsert (not onConflictDoNothing) so this suite always controls the
  // shared game_worlds row's exact state — season 1, week 52, day 1 —
  // regardless of what another suite (e.g. the worker e2e smoke, which
  // also uses the 'main' world id) may have left behind in the shared
  // test database.
  await db
    .insert(schema.gameWorlds)
    .values({ id: 'main', season: 1, week: 52, currentDay: 1, updatedAt: new Date() })
    // updated_at is the world heartbeat (GET /world/clock, GET /health):
    // refresh it here too, or a row left over from an older run reads as
    // "stalled" even though this suite just brought the world up.
    .onConflictDoUpdate({ target: schema.gameWorlds.id, set: { season: 1, week: 52, currentDay: 1, lastAppliedTick: null, updatedAt: new Date() } });
  matchLogDirectory = await mkdtemp(join(tmpdir(), 'api-match-logs-'));
  deps = buildDependencies({
    db,
    matchLogDirectory,
    logEvent: () => {},
  });
  app = buildApp({ deps, logger: false });
  await app.ready();
});

beforeEach(async () => {
  // ranking_ledger/titles have FKs to both players and tournaments —
  // must go before either; peak_rankings/training_schedule only
  // reference players.
  await db.delete(schema.managerEntryActivity); // FKs to players AND tournaments — before both
  await db.delete(schema.weeklyEntryClaims); // FKs to players AND tournaments — before both
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
  // Masters Cup rows have no FK to players/tournaments, but they DO
  // reference players by id in their jsonb and the ledger FKs to the
  // cup id (post discipline-fix); wipe them so a cup test starts clean.
  await db.delete(schema.mastersCups);
  await db.delete(schema.players);
  await db.delete(schema.managerEntitlements);
  await db.delete(schema.managerCosmetics);
  await db.delete(schema.managerProgression);
  // Notification tables FK managers.id — must go before the managers wipe.
  await db.delete(schema.notificationDeliveries);
  await db.delete(schema.managerNotificationStates);
  // Not previously truncated — harmless as long as every test's manager
  // account only ever ends up 'active' (re-upserting an active row back
  // to active is idempotent). The account-deletion tests below leave a
  // manager permanently in a terminal 'deleted' status, which — left
  // untruncated — would incorrectly block that same manager id's next
  // test run from re-authenticating. Found via a real failure: this
  // suite passed alone but failed on a second run against the same
  // persistent test database, for exactly this reason.
  await db.delete(schema.managers);
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

/** Claiming now costs XP (see docs/manager-xp-and-coaching-system.md) —
 * comfortably more than any single fixedAttributes(30) candidate could
 * ever cost, so every hirePlayer() call in these HTTP-level tests
 * (which are about roster caps, ranking points, etc., not pricing
 * itself) can keep assuming the claim succeeds on ability grounds
 * alone. Pricing itself has its own dedicated coverage in
 * ClaimTalentPoolCandidateUseCase.test.ts. */
const AMPLE_XP_FOR_TESTS = 100_000;

/** Seeds a free-agent Player at a fixed id/attribute baseline, funds
 * the claiming manager with ample XP, then signs it through the real
 * HTTP endpoint (POST /talent-pool/:id/claim), so callers can keep
 * using the same `p1`-style ids the old direct-hire helper used. */
async function hirePlayer(id: string, managerId: string): Promise<number> {
  const agingPolicy = new StandardAgingPolicy();
  await deps.players.save(
    Player.generateFillOnly(
      PlayerId(id),
      `Player ${id}`,
      750,
      agingPolicy.stageForAge(750),
      fixedAttributes(30),
      'BR',
      100,
      { speed: 100, stamina: 100, strength: 100 },
    ),
  );
  await deps.managerXp.credit(ManagerId(managerId), AMPLE_XP_FOR_TESTS);
  const response = await app.inject({
    method: 'POST',
    url: `/talent-pool/${id}/claim`,
    headers: { 'x-dev-manager-id': managerId },
    payload: { managerId },
  });
  return response.statusCode;
}

/** Deterministic "which bracket slot wins" doubles simulator, so the
 * item-2.3 award regression can pin BOTH orientations against real
 * persistence (the real simulator's outcome depends on attributes+RNG). */
class FixedSlotWinnerSimulator implements MatchSimulator {
  constructor(private readonly winningSide: 'A' | 'B') {}
  simulate<S extends string>(playerA: MatchParticipant<S>, playerB: MatchParticipant<S>, _surface: Surface): SimulatedMatch<S> {
    const winner = this.winningSide === 'A' ? playerA : playerB;
    const loser = this.winningSide === 'A' ? playerB : playerA;
    return {
      outcome: { winner: winner.playerId, loser: loser.playerId, setScores: [{ winnerGames: 6, loserGames: 0 }] },
      log: { entries: [], points: [], totalDurationSeconds: 0 },
    };
  }
}

class NoopEventPublisherForDoubles {
  async publish(): Promise<void> {}
}

/**
 * Wraps the real tournament repository and fails the FIRST `save` with
 * the exact ConcurrentModificationError a concurrent writer produces —
 * a genuine interleaving is not forceable from a test, so this is how
 * the registration retry (item 2.2) is proven deterministically against
 * real Postgres: attempt 1 loads, mutates, loses the "race"; the retry
 * reloads fresh state and lands. Every other method delegates.
 */
class FlakyFirstSaveTournamentRepository implements TournamentRepository {
  private failNext = true;
  constructor(private readonly inner: TournamentRepository) {}
  findById(id: TournamentId): Promise<Tournament | null> {
    return this.inner.findById(id);
  }
  findOpenForRegistration(): Promise<Tournament[]> {
    return this.inner.findOpenForRegistration();
  }
  findStarted(): Promise<Tournament[]> {
    return this.inner.findStarted();
  }
  findByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return this.inner.findByPlayerAndWeek(playerId, week);
  }
  findDoublesByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return this.inner.findDoublesByPlayerAndWeek(playerId, week);
  }
  async save(tournament: Tournament): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new ConcurrentModificationError(tournament.id);
    }
    return this.inner.save(tournament);
  }
}

describe('API', () => {
  it('serves the health check with the world heartbeat', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; lastTickAt: string | null; stale: boolean };
    expect(body.status).toBe('ok');
    // The suite's beforeAll upserts the 'main' world, so updated_at is
    // fresh — never stale here. lastTickAt is an ISO string or null.
    expect(body.lastTickAt === null || typeof body.lastTickAt === 'string').toBe(true);
    expect(body.stale).toBe(false);
  });

  it('self-describes every registered route via GET /routes, collected from the real Fastify registration (not a hand-maintained list)', async () => {
    const response = await app.inject({ method: 'GET', url: '/routes' });
    expect(response.statusCode).toBe(200);
    const routes = response.json() as Array<{ method: string; url: string }>;
    expect(routes.length).toBeGreaterThan(20);
    expect(routes).toContainEqual({ method: 'GET', url: '/managers/:id/entitlement' });
    expect(routes).toContainEqual({ method: 'GET', url: '/managers/:id/doubles-pairs' });
    // GET /routes itself is a real registered route, so it lists itself.
    expect(routes).toContainEqual({ method: 'GET', url: '/routes' });
  });

  it('marks every row in the open-tournament list with registrationOpen: true, explicit rather than left for the client to derive', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/tournaments/open-registration',
      headers: { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' },
      payload: { tournamentId: 't-reg-open', tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 52 }, drawSize: 16 },
    });
    expect(opened.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/tournaments?status=open' });
    expect(list.statusCode).toBe(200);
    const row = list.json().find((t: { id: string }) => t.id === 't-reg-open');
    expect(row).toBeDefined();
    expect(row.registrationOpen).toBe(true);
  });

  it('surfaces the ranking-based tier restriction in the player-scoped open list, and enforces the same rule on POST', async () => {
    const adminHeaders = { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' };
    for (const [id, tier] of [['t-futures-rr', 'futures'], ['t-challenger-rr', 'challenger']] as const) {
      const opened = await app.inject({
        method: 'POST',
        url: '/tournaments/open-registration',
        headers: adminHeaders,
        payload: { tournamentId: id, tier, surface: 'clay', weekScheduled: { season: 1, week: 52 }, drawSize: 16 },
      });
      expect(opened.statusCode).toBe(201);
    }

    // A manager with a rank-100 senior player: 99 players seeded ahead of
    // them in the rolling ledger, so the real RankPositionQuery places the
    // subject at exactly #100 — inside the futures cutoff (200), outside
    // the challenger one (50).
    const managerId = 'm-rank-rules';
    expect(await hirePlayer('rank-subject', managerId)).toBe(201);
    const agingPolicy = new StandardAgingPolicy();
    for (let i = 0; i < 99; i++) {
      await deps.players.save(
        Player.generateFillOnly(
          PlayerId(`rank-ahead-${i}`),
          `Ahead ${i}`,
          750,
          agingPolicy.stageForAge(750),
          fixedAttributes(30),
          'BR',
          100,
          { speed: 100, stamina: 100, strength: 100 },
        ),
      );
      await db.insert(schema.rankingLedger).values({
        id: `ledger-ahead-${i}`,
        playerId: `rank-ahead-${i}`,
        tournamentId: 't-futures-rr',
        tier: 'challenger',
        ageBand: null,
        points: 10_000 - i,
        seasonEarned: 1,
        weekEarned: 52,
      });
    }
    await db.insert(schema.rankingLedger).values({
      id: 'ledger-rank-subject',
      playerId: 'rank-subject',
      tournamentId: 't-futures-rr',
      tier: 'challenger',
      ageBand: null,
      points: 1,
      seasonEarned: 1,
      weekEarned: 52,
    });

    const list = await app.inject({ method: 'GET', url: '/tournaments?status=open&playerId=rank-subject' });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; rankRestricted: boolean; rankRestrictedReason: string | null }>;
    const futures = rows.find((r) => r.id === 't-futures-rr')!;
    const challenger = rows.find((r) => r.id === 't-challenger-rr')!;
    expect(futures.rankRestricted).toBe(true);
    expect(futures.rankRestrictedReason).toContain('too high to enter a futures event');
    expect(challenger.rankRestricted).toBe(false);
    expect(challenger.rankRestrictedReason).toBeNull();

    // The preview flag and the server enforcement are the SAME decision.
    const refused = await app.inject({
      method: 'POST',
      url: '/tournaments/t-futures-rr/entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'rank-subject' },
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toContain('too high to enter a futures event');

    const accepted = await app.inject({
      method: 'POST',
      url: '/tournaments/t-challenger-rr/entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'rank-subject' },
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('lets a top-50 player enter challengers up to the per-season soft cap, refuses the next (singles AND doubles), and the preview agrees (Batch 4B, F1)', async () => {
    const adminHeaders = { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' };
    // Five challenger events in five different weeks of season 2 — the
    // senior weekly cap is one tournament per week, so distinct weeks
    // isolate the SEASON cap under test. Season 2 is ahead of the world's
    // S1W52 clock, so every row stays in the open list.
    const ids = ['t-sc-1', 't-sc-2', 't-sc-3', 't-sc-4', 't-sc-5'];
    for (let i = 0; i < ids.length; i++) {
      const opened = await app.inject({
        method: 'POST',
        url: '/tournaments/open-registration',
        headers: adminHeaders,
        payload: {
          tournamentId: ids[i],
          tier: 'challenger',
          surface: 'clay',
          weekScheduled: { season: 2, week: i + 1 },
          drawSize: 16,
        },
      });
      expect(opened.statusCode).toBe(201);
    }

    // A manager with a rank-50 senior player: 49 players seeded ahead in
    // the rolling ledger, so the real RankPositionQuery places the subject
    // at exactly #50 — INSIDE the challenger soft-cap cutoff.
    const managerId = 'm-season-cap';
    expect(await hirePlayer('cap50-subject', managerId)).toBe(201);
    const agingPolicy = new StandardAgingPolicy();
    for (let i = 0; i < 49; i++) {
      await deps.players.save(
        Player.generateFillOnly(
          PlayerId(`sc-ahead-${i}`),
          `Cap Ahead ${i}`,
          750,
          agingPolicy.stageForAge(750),
          fixedAttributes(30),
          'BR',
          100,
          { speed: 100, stamina: 100, strength: 100 },
        ),
      );
      await db.insert(schema.rankingLedger).values({
        id: `ledger-sc-ahead-${i}`,
        playerId: `sc-ahead-${i}`,
        tournamentId: 't-sc-seed',
        tier: 'challenger',
        ageBand: null,
        points: 10_000 - i,
        seasonEarned: 1,
        weekEarned: 52,
      });
    }
    await db.insert(schema.rankingLedger).values({
      id: 'ledger-sc-subject',
      playerId: 'cap50-subject',
      tournamentId: 't-sc-seed',
      tier: 'challenger',
      ageBand: null,
      points: 1,
      seasonEarned: 1,
      weekEarned: 52,
    });

    // The hard challenger bar is gone: the first three entries succeed.
    for (const id of ids.slice(0, 3)) {
      const entered = await app.inject({
        method: 'POST',
        url: `/tournaments/${id}/entrants`,
        headers: { 'x-dev-manager-id': managerId },
        payload: { playerId: 'cap50-subject' },
      });
      expect(entered.statusCode).toBe(201);
    }

    // The preview and the server enforcement are the SAME decision: the
    // unentered week-4/5 rows report the cap used up and are disabled; an
    // already-entered row excludes its own tournament (2 used, not 3) and
    // stays enterable. Challenger is never hard-barred.
    const list = await app.inject({ method: 'GET', url: '/tournaments?status=open&playerId=cap50-subject' });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{
      id: string;
      rankRestricted: boolean;
      seasonCapRestricted: boolean;
      seasonCapReason: string | null;
      seasonCapUsedThisSeason: number | null;
      seasonCapLimitThisSeason: number | null;
    }>;
    const fourth = rows.find((r) => r.id === 't-sc-4')!;
    expect(fourth.rankRestricted).toBe(false);
    expect(fourth.seasonCapRestricted).toBe(true);
    expect(fourth.seasonCapUsedThisSeason).toBe(3);
    expect(fourth.seasonCapLimitThisSeason).toBe(3);
    expect(fourth.seasonCapReason).toContain('all 3 are used');
    expect(rows.find((r) => r.id === 't-sc-5')!.seasonCapRestricted).toBe(true);
    const first = rows.find((r) => r.id === 't-sc-1')!;
    expect(first.seasonCapRestricted).toBe(false);
    expect(first.seasonCapUsedThisSeason).toBe(2); // its own entry excluded

    // The fourth singles attempt is refused with the SAME reason, and so
    // is a fourth attempt through the doubles field (no discipline
    // loophole).
    const refusedSingles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-sc-4/entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'cap50-subject' },
    });
    expect(refusedSingles.statusCode).toBe(409);
    expect((refusedSingles.json() as { error: string }).error).toContain('all 3 are used');

    const refusedDoubles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-sc-4/doubles-entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'cap50-subject' },
    });
    expect(refusedDoubles.statusCode).toBe(409);
    expect((refusedDoubles.json() as { error: string }).error).toContain('all 3 are used');

    // Same-event singles+doubles counts once: the doubles of week 3 (where
    // the player already holds singles) is NOT a fourth challenger.
    const sameEventDoubles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-sc-3/doubles-entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'cap50-subject' },
    });
    expect(sameEventDoubles.statusCode).toBe(201);
  });

  it('counts singles + doubles at the SAME event as ONE weekly entry — display and enforcement agree, and a second event is still refused at the senior cap of 1', async () => {
    const adminHeaders = { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' };
    for (const id of ['t-same-event-cap', 't-other-event-cap']) {
      const opened = await app.inject({
        method: 'POST',
        url: '/tournaments/open-registration',
        headers: adminHeaders,
        payload: { tournamentId: id, tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 52 }, drawSize: 16 },
      });
      expect(opened.statusCode).toBe(201);
    }

    const managerId = 'm-same-event-cap';
    expect(await hirePlayer('cap-subject', managerId)).toBe(201);
    const singles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-same-event-cap/entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'cap-subject' },
    });
    expect(singles.statusCode).toBe(201);

    // The display helper mirrors enforcement: the tournament already
    // entered EXCLUDES itself (0/1 — its doubles is still enterable),
    // while a different same-week senior event counts the entry (1/1).
    const list = await app.inject({ method: 'GET', url: '/tournaments?status=open&playerId=cap-subject' });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; weeklyEntryCountThisWeek: number; weeklyEntryCapThisWeek: number }>;
    expect(rows.find((r) => r.id === 't-same-event-cap')).toMatchObject({ weeklyEntryCountThisWeek: 0, weeklyEntryCapThisWeek: 1 });
    expect(rows.find((r) => r.id === 't-other-event-cap')).toMatchObject({ weeklyEntryCountThisWeek: 1, weeklyEntryCapThisWeek: 1 });

    // Enforcement agrees: doubles at the SAME event passes at cap 1...
    const doubles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-same-event-cap/doubles-entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'cap-subject' },
    });
    expect(doubles.statusCode).toBe(201);
    expect((doubles.json() as { doublesEntrants: string[] }).doublesEntrants).toContain('cap-subject');

    // ...while doubles at a DIFFERENT event is a real second entry, refused.
    const otherDoubles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-other-event-cap/doubles-entrants',
      headers: { 'x-dev-manager-id': managerId },
      payload: { playerId: 'cap-subject' },
    });
    expect(otherDoubles.statusCode).toBe(409);
    expect((otherDoubles.json() as { error: string }).error).toContain('already entered 1 senior tournaments');
  });

  it('serves the world clock: the real seeded GameWeek + day plus a next-tick timestamp derived from WORLD_TICK_CRON', async () => {
    const response = await app.inject({ method: 'GET', url: '/world/clock' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Matches beforeAll's seeded row (season: 1, week: 52) — proves this
    // reads the same "main" GameWorld row apps/worker advances, not a
    // second, independently-tracked notion of the current week.
    expect(body.currentWeek).toEqual({ season: 1, week: 52 });
    // Day clock: the seeded row defaults to day 1 of a 7-day week.
    expect(body.currentDay).toBe(1);
    expect(body.daysPerWeek).toBe(7);
    const nextTickAt = new Date(body.nextTickAt);
    expect(nextTickAt.getTime()).toBeGreaterThan(Date.now());
    // Default WORLD_TICK_CRON ('0 3 * * *') fires daily at 03:00 —
    // asserted structurally rather than pinned to a literal date so
    // this doesn't rot with the passage of time.
    expect(nextTickAt.getHours()).toBe(3);
    // nextWeekTickAt is the next weekly rollover (day 7 -> day 1), which
    // weekly systems (talent-pool refresh, aging) fire on. From day 1
    // that's 7 day-ticks out — strictly after the next daily tick.
    const nextWeekTickAt = new Date(body.nextWeekTickAt);
    expect(nextWeekTickAt.getTime()).toBeGreaterThan(nextTickAt.getTime());
    expect(nextWeekTickAt.getHours()).toBe(3);
  });

  it('serves an interval-mode next-tick timestamp anchored to the last applied tick when WORLD_TICK_INTERVAL_MS is set', async () => {
    // Pins the anchor precisely rather than trusting "recently written
    // by beforeAll" — this is what AdvanceWorldWeekUseCase's save()
    // actually bumps on a real applied tick (see
    // DrizzleGameWorldRepository.findLastTickAt's doc comment).
    const lastTickAt = new Date('2026-01-05T12:00:00.000Z');
    await db.update(schema.gameWorlds).set({ updatedAt: lastTickAt }).where(eq(schema.gameWorlds.id, 'main'));

    process.env.WORLD_TICK_INTERVAL_MS = '3600000'; // 1 hour
    try {
      const response = await app.inject({ method: 'GET', url: '/world/clock' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(new Date(body.nextTickAt).getTime()).toBe(lastTickAt.getTime() + 3_600_000);
      // Seeded world is at day 1 -> 7 day-ticks to the weekly rollover.
      expect(new Date(body.nextWeekTickAt).getTime()).toBe(lastTickAt.getTime() + 3_600_000 * 7);
    } finally {
      delete process.env.WORLD_TICK_INTERVAL_MS;
    }
  });

  it('reports the world as stale in interval mode once elapsed exceeds two tick intervals', async () => {
    process.env.WORLD_TICK_INTERVAL_MS = '60000'; // 1 minute per game day
    try {
      // 3 minutes without an applied tick is > 2 x the 1-minute interval.
      const threeMinutesAgo = new Date(Date.now() - 3 * 60_000);
      await db.update(schema.gameWorlds).set({ updatedAt: threeMinutesAgo }).where(eq(schema.gameWorlds.id, 'main'));

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect((health.json() as { stale: boolean }).stale).toBe(true);

      const clock = await app.inject({ method: 'GET', url: '/world/clock' });
      expect(clock.statusCode).toBe(200);
      expect((clock.json() as { stale: boolean }).stale).toBe(true);
    } finally {
      delete process.env.WORLD_TICK_INTERVAL_MS;
      // Restore the heartbeat so later tests don't inherit a stalled world.
      await db.update(schema.gameWorlds).set({ updatedAt: new Date() }).where(eq(schema.gameWorlds.id, 'main'));
    }
  });

  it('requires authenticated manager identity and isolates manager-owned actions', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/players' })).statusCode).toBe(401);
    expect(await hirePlayer('owned-p1', 'm1')).toBe(201);

    const crossManagerRead = await app.inject({ method: 'GET', url: '/managers/m1/players', headers: { 'x-dev-manager-id': 'm2' } });
    expect(crossManagerRead.statusCode).toBe(404);

    const crossManagerMutation = await app.inject({
      method: 'PUT',
      url: '/players/owned-p1/training-focus',
      headers: { 'x-dev-manager-id': 'm2' },
      payload: { focus: { kind: 'attribute', attribute: 'serve' } },
    });
    expect(crossManagerMutation.statusCode).toBe(404);

    const ownManagerRead = await app.inject({ method: 'GET', url: '/me/players', headers: { 'x-dev-manager-id': 'm1' } });
    expect(ownManagerRead.statusCode).toBe(200);
    expect(ownManagerRead.json().map((player: { id: string }) => player.id)).toEqual(['owned-p1']);
  });

  it('hires a player and reads it back', async () => {
    expect(await hirePlayer('p1', 'm1')).toBe(201);

    const response = await app.inject({ method: 'GET', url: '/players/p1' });
    expect(response.statusCode).toBe(200);
    const dto = response.json();
    expect(dto.id).toBe('p1');
    expect(dto.name).toBe('Player p1');
    expect(dto.stage).toBe('youth');
    expect(dto.fillOnly).toBe(false);
    expect(dto.attributes.technical.serve).toBe(30);
    expect(dto.attributes.surfaceAffinities.clay).toBe(20);
  });

  it('deletes a manager account: releases the roster (players survive, unowned) and blocks re-authentication as that account', async () => {
    expect(await hirePlayer('del-p1', 'del-m1')).toBe(201);
    expect(await hirePlayer('del-p2', 'del-m1')).toBe(201);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { 'x-dev-manager-id': 'del-m1' } });
    expect(me.statusCode).toBe(200);

    const deletion = await app.inject({ method: 'DELETE', url: '/me/account', headers: { 'x-dev-manager-id': 'del-m1' } });
    expect(deletion.statusCode).toBe(204);

    // The players themselves survive, released (not deleted) — their
    // game history belongs to the Player aggregate, not the manager.
    const p1 = await app.inject({ method: 'GET', url: '/players/del-p1' });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().managerId).toBeNull();
    const p2 = await app.inject({ method: 'GET', url: '/players/del-p2' });
    expect(p2.json().managerId).toBeNull();

    // The same dev identity can no longer authenticate as this account —
    // not silently revived by a repeat request with the same header.
    const meAgain = await app.inject({ method: 'GET', url: '/auth/me', headers: { 'x-dev-manager-id': 'del-m1' } });
    expect(meAgain.statusCode).toBe(403);
    expect(meAgain.json().error).toMatch(/deleted/i);

    const deleteAgain = await app.inject({ method: 'DELETE', url: '/me/account', headers: { 'x-dev-manager-id': 'del-m1' } });
    expect(deleteAgain.statusCode).toBe(403);
  });

  it('exposes fillOnly on a filler free agent, so the bracket UI can distinguish it from a real entrant', async () => {
    const agingPolicy = new StandardAgingPolicy();
    await deps.players.save(
      Player.generateFillOnly(
        PlayerId('filler-p1'),
        'Filler Player',
        900,
        agingPolicy.stageForAge(900),
        fixedAttributes(40),
        'BR',
        60,
        { speed: 60, stamina: 60, strength: 60 },
      ),
    );

    const response = await app.inject({ method: 'GET', url: '/players/filler-p1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().fillOnly).toBe(true);
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
      headers: { 'x-dev-manager-id': 'm1' },
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
      headers: { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' },
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

    const simulated = await app.inject({ method: 'POST', url: '/tournaments/t1/matches/1/0/simulate', headers: { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' } });
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

    // Prize money: the tournament's per-round ladder (mirrors
    // pointsBreakdown), and the round-1 loser's real credited money —
    // unlike ranking points, a first-round loss pays SOMETHING (real
    // ATP rule 3.08.B.3, "paid to play").
    expect(dto.prizeMoneyBreakdown[0].stageLabel).toBe('Champion');
    expect(dto.prizeMoneyBreakdown[dto.prizeMoneyBreakdown.length - 1].matchesWon).toBe(0);
    expect(dto.prizeMoneyBreakdown[dto.prizeMoneyBreakdown.length - 1].prizeMoney).toBeGreaterThan(0);
    const loserId = match.outcome.winner === match.entrantA ? match.entrantB : match.entrantA;
    const loserProfile = await app.inject({ method: 'GET', url: `/players/${loserId}` });
    expect(loserProfile.statusCode).toBe(200);
    expect(loserProfile.json().careerPrizeMoney).toBe(dto.prizeMoneyBreakdown[dto.prizeMoneyBreakdown.length - 1].prizeMoney);

    // Re-simulating the same slot must fail (already-decided match), not overwrite.
    const again = await app.inject({ method: 'POST', url: '/tournaments/t1/matches/1/0/simulate', headers: { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' } });
    expect(again.statusCode).toBe(409);

    // The replay blob is served by the dev match-log route, immutable-cached.
    const replay = await app.inject({ method: 'GET', url: '/match-logs/t1-r1-m0.json' });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['cache-control']).toContain('immutable');
    const log = replay.json();
    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.totalDurationSeconds).toBeGreaterThan(0);
  });

  it('forms a real doubles bracket from a lightly-subscribed field via the real HTTP registration route + real Postgres (P7b padding fix)', async () => {
    // Reproduces, end-to-end through the real stack (not an in-memory
    // fake), the exact live bug an extended LLM-manager playtest found:
    // a doubles field with too few real registrants never crossed
    // FormDoublesDrawUseCase's 2-pair minimum and silently never played.
    // See FormDoublesDrawUseCase.ts's own doc comment on the fix (padding
    // the pairing input from free agents) and its unit test file for the
    // in-memory-level coverage; this proves the same fix through a real
    // HTTP registration + real Drizzle repositories + real Postgres.
    expect(await hirePlayer('dbl-a', 'm-doubles')).toBe(201);
    expect(await hirePlayer('dbl-b', 'm-doubles')).toBe(201);

    const tournament = Tournament.open({
      name: 'Test Doubles Field',
      id: TournamentId('t-doubles-field'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 52 },
      drawSize: 16,
      doublesDrawSize: 8,
    });
    await deps.tournaments.save(tournament);

    for (const playerId of ['dbl-a', 'dbl-b']) {
      const registered = await app.inject({
        method: 'POST',
        url: '/tournaments/t-doubles-field/doubles-entrants',
        headers: { 'x-dev-manager-id': 'm-doubles' },
        payload: { playerId },
      });
      expect(registered.statusCode).toBe(201);
    }

    const agingPolicy = new StandardAgingPolicy();
    for (let i = 1; i <= 20; i++) {
      await deps.players.save(
        Player.generateFillOnly(
          PlayerId(`dbl-filler-${i}`),
          `Filler ${i}`,
          25 * 52,
          agingPolicy.stageForAge(25 * 52),
          fixedAttributes(30),
          'BR',
          100,
          { speed: 100, stamina: 100, strength: 100 },
        ),
      );
    }

    // Only 2 real registrants entered a field that needs 16 to fill —
    // before the fix, this stayed exactly 1 formed pair forever, and
    // hasDoublesDrawStarted never became true.
    const beforeForm = await deps.tournaments.findById(TournamentId('t-doubles-field'));
    await deps.formDoublesDraw.form(beforeForm!);

    const formed = await deps.tournaments.findById(TournamentId('t-doubles-field'));
    expect(formed!.hasDoublesDrawStarted).toBe(true);
    expect(formed!.doublesPairs.length).toBeGreaterThanOrEqual(2);
    const usedPlayerIds = formed!.doublesPairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(usedPlayerIds).toContain(PlayerId('dbl-a'));
    expect(usedPlayerIds).toContain(PlayerId('dbl-b'));

    const fetched = await app.inject({ method: 'GET', url: '/tournaments/t-doubles-field' });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().doublesPairs.length).toBeGreaterThanOrEqual(2);
  });

  it('closes the full doubles loop: a lone persistent pair forms a padded bracket, plays a real match, and gains chemistry (was permanently stuck at 0)', async () => {
    expect(await hirePlayer('dbl-c', 'm-doubles-2')).toBe(201);
    expect(await hirePlayer('dbl-d', 'm-doubles-2')).toBe(201);
    await deps.doublesPairs.save(DoublesPair.activate(PairId('pp-cd'), PlayerId('dbl-c'), PlayerId('dbl-d')));

    const tournament = Tournament.open({
      name: 'Test Doubles Chemistry Field',
      id: TournamentId('t-doubles-chemistry'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 52 },
      drawSize: 16,
      doublesDrawSize: 8,
    });
    await deps.tournaments.save(tournament);

    for (const playerId of ['dbl-c', 'dbl-d']) {
      const registered = await app.inject({
        method: 'POST',
        url: '/tournaments/t-doubles-chemistry/doubles-entrants',
        headers: { 'x-dev-manager-id': 'm-doubles-2' },
        payload: { playerId },
      });
      expect(registered.statusCode).toBe(201);
    }

    const agingPolicy = new StandardAgingPolicy();
    for (let i = 1; i <= 20; i++) {
      await deps.players.save(
        Player.generateFillOnly(
          PlayerId(`dbl-chem-filler-${i}`),
          `Chem Filler ${i}`,
          25 * 52,
          agingPolicy.stageForAge(25 * 52),
          fixedAttributes(30),
          'BR',
          100,
          { speed: 100, stamina: 100, strength: 100 },
        ),
      );
    }

    const beforeForm = await deps.tournaments.findById(TournamentId('t-doubles-chemistry'));
    await deps.formDoublesDraw.form(beforeForm!);

    const formed = await deps.tournaments.findById(TournamentId('t-doubles-chemistry'));
    expect(formed!.hasDoublesDrawStarted).toBe(true);
    // The persistent pair must have been kept together, not split up by
    // the padding fillers.
    const cdPair = formed!.doublesPairs.find(
      (p) => (p.playerA === PlayerId('dbl-c') && p.playerB === PlayerId('dbl-d')) || (p.playerA === PlayerId('dbl-d') && p.playerB === PlayerId('dbl-c')),
    );
    expect(cdPair).toBeDefined();

    await deps.simulateDueMatches.execute({ worldId: WorldId('main') });

    const afterSweep = await deps.tournaments.findById(TournamentId('t-doubles-chemistry'));
    const decidedRound1 = afterSweep!.getDoublesRounds()[0];
    expect(decidedRound1.matches.some((m) => m.outcome !== null)).toBe(true);

    // Prize money: awardDoublesResult pays BOTH sides of any decided
    // doubles round (mirroring how this codebase's existing doubles
    // RANKING POINTS already work — unlike singles, a doubles winner is
    // credited again at each round they advance, not only at the
    // final), so pair CD has real prize money either way once their
    // round-1 match is decided.
    const cdMatch = decidedRound1.matches.find((m) => m.entrantA === cdPair!.pairId || m.entrantB === cdPair!.pairId);
    expect(cdMatch?.outcome).toBeTruthy();
    const cAfterSweep = await deps.players.findById(PlayerId('dbl-c'));
    expect(cAfterSweep!.careerPrizeMoney).toBeGreaterThan(0);
    expect(cAfterSweep!.seasonPrizeMoney).toBe(cAfterSweep!.careerPrizeMoney);

    const pairsResponse = await app.inject({ method: 'GET', url: '/managers/m-doubles-2/doubles-pairs', headers: { 'x-dev-manager-id': 'm-doubles-2' } });
    expect(pairsResponse.statusCode).toBe(200);
    const pairDto = pairsResponse.json().find((p: { id: string }) => p.id === 'pp-cd');
    expect(pairDto).toBeDefined();
    // Before this fix, this pair's doubles draw NEVER formed at all
    // (hasDoublesDrawStarted stayed false forever), so this chemistry
    // value was permanently stuck at 0. Now the pair actually gets to
    // play, so it moves.
    expect(pairDto.chemistry).toBeGreaterThan(0);

    // API-clarity fix: the profile's doublesPartner previously omitted
    // chemistry entirely, even though the value was already in scope
    // server-side — a client had no way to show it without a second
    // /managers/:id/doubles-pairs round trip.
    const profile = await app.inject({ method: 'GET', url: '/players/dbl-c/profile' });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().doublesPartner).toMatchObject({ playerId: 'dbl-d', chemistry: pairDto.chemistry });
    expect(profile.json().careerPrizeMoney).toBe(cAfterSweep!.careerPrizeMoney);
    expect(profile.json().seasonPrizeMoney).toBe(cAfterSweep!.seasonPrizeMoney);
  });

  it('a cross-manager pair request is refused with a clear message and writes nothing (was: 201 + a pending invite that blocked the requester)', async () => {
    expect(await hirePlayer('pair-a1', 'm-pair-a')).toBe(201);
    expect(await hirePlayer('pair-a2', 'm-pair-a')).toBe(201);
    expect(await hirePlayer('pair-other', 'm-pair-b')).toBe(201);

    // The exact live shape: manager A asks to pair with manager B's
    // player. This used to return 201 and create a `pending` row that
    // occupied BOTH players' one-pair slot forever (the season-4 agent
    // had to dissolve it before their real pairing could land).
    const refused = await app.inject({
      method: 'POST',
      url: '/doubles-pairs',
      headers: { 'x-dev-manager-id': 'm-pair-a' },
      payload: { playerA: 'pair-a1', playerB: 'pair-other' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/not on manager m-pair-a's roster/);

    // Nothing was written — no pending row to block the real pair.
    const rowsAfterRefusal = await db.select().from(schema.doublesPairs);
    expect(rowsAfterRefusal).toHaveLength(0);

    // The requester can form their REAL, own-roster pair immediately.
    const formed = await app.inject({
      method: 'POST',
      url: '/doubles-pairs',
      headers: { 'x-dev-manager-id': 'm-pair-a' },
      payload: { playerA: 'pair-a1', playerB: 'pair-a2' },
    });
    expect(formed.statusCode).toBe(201);
    expect(formed.json().status).toBe('active');
    const rowsAfterForm = await db.select().from(schema.doublesPairs);
    expect(rowsAfterForm).toHaveLength(1);
    expect(rowsAfterForm[0].status).toBe('active');
  });

  it('concurrent singles and doubles registrations on the SAME tournament both land (agent-season A)', async () => {
    // The reported flow: two managers acting at once, one entering
    // singles and one entering doubles. Before the fix, whichever side
    // committed second could be refused once the other manager's flow
    // formed the doubles draw (which flipped the broad `hasStarted` gate).
    expect(await hirePlayer('gate-s1', 'm-gate-a')).toBe(201);
    expect(await hirePlayer('gate-d1', 'm-gate-b')).toBe(201);

    await deps.tournaments.save(
      Tournament.open({
        name: 'Gate Concurrent Open',
        id: TournamentId('t-gate-concurrent'),
        tier: 'challenger',
        surface: 'hard',
        weekScheduled: { season: 1, week: 52 },
        drawSize: 16,
        doublesDrawSize: 8,
      }),
    );

    const [singles, doubles] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/tournaments/t-gate-concurrent/entrants',
        headers: { 'x-dev-manager-id': 'm-gate-a' },
        payload: { playerId: 'gate-s1' },
      }),
      app.inject({
        method: 'POST',
        url: '/tournaments/t-gate-concurrent/doubles-entrants',
        headers: { 'x-dev-manager-id': 'm-gate-b' },
        payload: { playerId: 'gate-d1' },
      }),
    ]);
    expect(singles.statusCode).toBe(201);
    expect(doubles.statusCode).toBe(201);

    const after = await deps.tournaments.findById(TournamentId('t-gate-concurrent'));
    expect(after!.entrants.some((e) => e.playerId === PlayerId('gate-s1'))).toBe(true);
    expect(after!.doublesEntrants).toContain(PlayerId('gate-d1'));
    // Neither competition has started — the tournament is still open.
    expect(after!.hasSinglesStarted).toBe(false);
    expect(after!.hasDoublesStarted).toBe(false);
    expect((await deps.tournaments.findOpenForSinglesRegistration()).map((t) => t.id)).toContain('t-gate-concurrent');
  });

  it('a FORMED doubles draw no longer blocks singles entries on the same tournament (the live griefing shape)', async () => {
    // Reproduces the verified live bug exactly: a 16-draw challenger
    // closed singles registration after a doubles draw formed, with the
    // singles field wide open. The doubles field here is formed through
    // the REAL FormDoublesDrawUseCase (padding included), then a singles
    // entry must still land.
    expect(await hirePlayer('gate-s2', 'm-gate-c')).toBe(201);
    expect(await hirePlayer('gate-d2', 'm-gate-c')).toBe(201);

    await deps.tournaments.save(
      Tournament.open({
        name: 'Gate Doubles First',
        id: TournamentId('t-gate-doubles-first'),
        tier: 'challenger',
        surface: 'hard',
        weekScheduled: { season: 1, week: 52 },
        drawSize: 16,
        doublesDrawSize: 8,
      }),
    );

    const doublesEntry = await app.inject({
      method: 'POST',
      url: '/tournaments/t-gate-doubles-first/doubles-entrants',
      headers: { 'x-dev-manager-id': 'm-gate-c' },
      payload: { playerId: 'gate-d2' },
    });
    expect(doublesEntry.statusCode).toBe(201);

    const agingPolicy = new StandardAgingPolicy();
    for (let i = 1; i <= 20; i++) {
      await deps.players.save(
        Player.generateFillOnly(
          PlayerId(`gate-filler-${i}`),
          `Gate Filler ${i}`,
          25 * 52,
          agingPolicy.stageForAge(25 * 52),
          fixedAttributes(30),
          'BR',
          100,
          { speed: 100, stamina: 100, strength: 100 },
        ),
      );
    }
    const beforeForm = await deps.tournaments.findById(TournamentId('t-gate-doubles-first'));
    await deps.formDoublesDraw.form(beforeForm!);

    const formed = await deps.tournaments.findById(TournamentId('t-gate-doubles-first'));
    expect(formed!.hasDoublesDrawStarted).toBe(true);
    expect(formed!.hasStarted).toBe(true); // broad flag IS true now...
    expect(formed!.hasSinglesStarted).toBe(false); // ...but singles has NOT begun
    // Discovery: the formed doubles bracket must not hide the event from
    // the still-open singles registration list.
    expect((await deps.tournaments.findOpenForSinglesRegistration()).map((t) => t.id)).toContain('t-gate-doubles-first');

    // The exact 409 from the season: this singles entry used to be
    // refused with "Cannot register an entrant: ... has already started".
    const lateSingles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-gate-doubles-first/entrants',
      headers: { 'x-dev-manager-id': 'm-gate-c' },
      payload: { playerId: 'gate-s2' },
    });
    expect(lateSingles.statusCode).toBe(201);

    const after = await deps.tournaments.findById(TournamentId('t-gate-doubles-first'));
    expect(after!.mainEntrants.some((e) => e.playerId === PlayerId('gate-s2'))).toBe(true);
  });

  it('the mirror: a STARTED singles draw no longer blocks doubles entries (the doubles draw forms from the late entry)', async () => {
    expect(await hirePlayer('gate-d3', 'm-gate-d')).toBe(201);

    // Seed the singles main draw directly through the aggregate (a real
    // 16-draw needs 9+ entrants before BracketGenerator can produce a
    // round-1 match), so the singles competition has genuinely begun.
    // Player rows first: tournament_entries FKs to players.
    const agingPolicy = new StandardAgingPolicy();
    const seedPlayer = (id: string) =>
      Player.generateFillOnly(
        PlayerId(id),
        `Gate Seed ${id}`,
        25 * 52,
        agingPolicy.stageForAge(25 * 52),
        fixedAttributes(30),
        'BR',
        100,
        { speed: 100, stamina: 100, strength: 100 },
      );
    const tournament = Tournament.open({
      name: 'Gate Singles First',
      id: TournamentId('t-gate-singles-first'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 52 },
      drawSize: 16,
      doublesDrawSize: 8,
    });
    for (let i = 0; i < 9; i++) {
      await deps.players.save(seedPlayer(`gate-seed-${i}`));
      tournament.registerEntrant({ playerId: PlayerId(`gate-seed-${i}`), seed: null });
    }
    tournament.startWithBracket(new BracketGenerator().generate(tournament.mainEntrants, 16));
    await deps.tournaments.save(tournament);

    for (let i = 1; i <= 20; i++) {
      await deps.players.save(seedPlayer(`gate-mirror-filler-${i}`));
    }

    // The singles draw standing started must NOT have closed doubles
    // entries — this is the mirror of the live bug. The doubles use case
    // forms the draw from this late entry (the singles auto-start had no
    // doubles entrants to form from).
    const doubles = await app.inject({
      method: 'POST',
      url: '/tournaments/t-gate-singles-first/doubles-entrants',
      headers: { 'x-dev-manager-id': 'm-gate-d' },
      payload: { playerId: 'gate-d3' },
    });
    expect(doubles.statusCode).toBe(201);

    const after = await deps.tournaments.findById(TournamentId('t-gate-singles-first'));
    expect(after!.doublesEntrants).toContain(PlayerId('gate-d3'));
    expect(after!.hasDoublesDrawStarted).toBe(true);
  });

  it('a season-final (week-50) major produces a champion inside the season — the 17-day qualifying span (agent-season B)', async () => {
    const worldId = WorldId('main');
    const originalWorld = await deps.worlds.findById(worldId);
    const agingPolicy = new StandardAgingPolicy();
    const filler = (id: string) =>
      Player.generateFillOnly(
        PlayerId(id),
        `Major Filler ${id}`,
        25 * 52,
        agingPolicy.stageForAge(25 * 52),
        fixedAttributes(30),
        'BR',
        100,
        { speed: 100, stamina: 100, strength: 100 },
      );
    try {
      // The real schedule's last in-season major start: week 50 (phase 11
      // → weeks 11/24/37/50). Its final lands S1W52 day 3 — in-season,
      // unlike the old week-51 start whose final fell on S2W1 day 3 (the
      // live bug: the agent season's fourth major never crowned anyone).
      await deps.worlds.save(
        GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 50 }, currentDay: 1, lastAppliedTick: null }),
      );
      const drawSize = 128 as const;
      await deps.tournaments.save(
        Tournament.open({
          name: 'E2E Season Final Major',
          id: TournamentId('t-major-e2e'),
          tier: 'major',
          surface: 'hard',
          weekScheduled: { season: 1, week: 50 },
          drawSize,
          qualifyingDrawSize: qualifyingDrawSizeFor('major', drawSize),
          qualifierSlots: qualifierSlotsFor('major', drawSize),
          wildCardSlots: wildCardSlotsFor('major'),
        }),
      );
      for (let i = 0; i < 260; i++) {
        await deps.players.save(filler(`major-filler-${i}`));
      }

      await deps.startDueTournaments.execute({ worldId });
      const seeded = await deps.tournaments.findById(TournamentId('t-major-e2e'));
      expect(seeded!.hasQualifyingDrawStarted).toBe(true);
      expect(seeded!.qualifyingEntrants.length).toBe(qualifyingDrawSizeFor('major', drawSize));

      // Day 1 of the event is `currentDay`; the final is scheduled for
      // event day 17 (16 days after the start) = S1W52 day 3, so 16 real
      // day ticks carry the tournament through qualifying, the deferred
      // main-draw seeding, and all seven main rounds.
      for (let day = 0; day < 16; day++) {
        await deps.advanceWorldWeek.execute({ worldId, tickKey: `e2e-major-tick-${day}` });
        await deps.simulateDueMatches.execute({ worldId });
        await deps.promoteQualifiers.execute({ worldId });
        await deps.promoteDoublesQualifiers.execute({ worldId });
      }

      const finished = await deps.tournaments.findById(TournamentId('t-major-e2e'));
      expect(finished!.isMainDrawFinished()).toBe(true);
      expect(finished!.cancelledAt).toBeNull();
      const titleRows = await db
        .select()
        .from(schema.titles)
        .where(eq(schema.titles.tournamentId, 't-major-e2e'));
      expect(titleRows).toHaveLength(1);
      // The champion is one of the tournament's own entrants, and the
      // world clock is still inside season 1 (the final did not leak).
      const championId = titleRows[0].playerId;
      expect(finished!.mainEntrants.map((e) => e.playerId as string)).toContain(championId);
      const clock = await deps.worlds.findById(worldId);
      expect(clock!.currentWeek.season).toBe(1);
    } finally {
      // The suite's shared world must be restored for every other test.
      await deps.worlds.save(originalWorld!);
    }
  }, 120_000);

  it('a brand-new roster is exempt from the inactivity deduction for its onboarding window (the claim week AND the next), and penalized from the third (agent-season E + season-4 extension)', async () => {
    const worldId = WorldId('main');
    const originalWorld = await deps.worlds.findById(worldId);
    const ladderPolicy = new StandardManagerLadderPolicy();
    const factor = ladderPolicy.weeklyDecayFactor();
    const penalty = ladderPolicy.inactivityPenaltyPoints();
    const agingPolicy = new StandardAgingPolicy();
    try {
      // Park the world at S1W52 d7: the next tick ends week 52, the
      // agent season's onboarding shape (claim mid-week, digest predates
      // the claim, no entry possible yet).
      await deps.worlds.save(
        GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 52 }, currentDay: 7, lastAppliedTick: null }),
      );

      // Manager m-onboard signs their only player THROUGH THE REAL ROUTE
      // during week 52.
      await deps.players.save(
        Player.generateFillOnly(
          PlayerId('onboard-free'),
          'Onboard Free',
          24 * 52,
          agingPolicy.stageForAge(24 * 52),
          fixedAttributes(35),
          'US',
        ),
      );
      await deps.managerXp.credit(ManagerId('m-onboard'), 10_000);
      const claimed = await app.inject({
        method: 'POST',
        url: '/talent-pool/onboard-free/claim',
        headers: { 'x-dev-manager-id': 'm-onboard' },
        payload: { managerId: 'm-onboard' },
      });
      expect(claimed.statusCode).toBe(201);

      // The stamped week round-trips through real Postgres exactly.
      const stamped = await deps.players.findById(PlayerId('onboard-free'));
      expect(stamped!.managerSinceWeek).toEqual({ season: 1, week: 52 });

      // The control: a roster that predates the onboarding window (two
      // weeks before the ending week — one week back would still be
      // inside the extended window).
      const veteran = Player.hire(
        PlayerId('veteran-p'),
        'Veteran',
        24 * 52,
        fixedAttributes(35),
        ManagerId('m-veteran'),
        'US',
        100,
        { speed: 100, stamina: 100, strength: 100 },
        50,
        { season: 1, week: 50 },
      );
      veteran.pullDomainEvents();
      await deps.players.save(veteran);

      await deps.managerLadder.credit(ManagerId('m-onboard'), 1000);
      await deps.managerLadder.credit(ManagerId('m-veteran'), 1000);

      const result = await deps.advanceWorldWeek.execute({ worldId, tickKey: 'e2e-onboarding-week-52' });
      expect(result.weekRolledOver).toBe(true);

      // The onboarding manager takes the routine decay only — the flat
      // −500 that used to wipe their first practice points is skipped.
      expect(await deps.managerLadder.scoreFor(ManagerId('m-onboard'))).toBeCloseTo(1000 * factor);
      // The veteran manager (zero entries, roster predating the week)
      // still takes it.
      expect(await deps.managerLadder.scoreFor(ManagerId('m-veteran'))).toBeCloseTo(1000 * factor - penalty);

      // The very next rollover (ending S2W1) is ALSO exempt — this is
      // the season-4 extension: the manager's S1W52 digest predated the
      // claim and the S2W1 digest was built before any entry could be
      // planned from it, so a −500 here is structurally impossible to
      // avoid by playing well. Tick a full S2W1 (the first tick above
      // left us at S2W1 day 1).
      let secondRollover = false;
      for (let i = 0; i < 8 && !secondRollover; i++) {
        const r = await deps.advanceWorldWeek.execute({ worldId, tickKey: `e2e-onboard-s2w1-${i}` });
        secondRollover = r.weekRolledOver;
      }
      expect(secondRollover).toBe(true);
      const afterSecond = 1000 * factor;
      expect(await deps.managerLadder.scoreFor(ManagerId('m-onboard'))).toBeCloseTo(afterSecond * factor);

      // The THIRD rollover (ending S2W2) ends the onboarding window — a
      // genuinely idle week now takes the normal deduction.
      let thirdRollover = false;
      for (let i = 0; i < 8 && !thirdRollover; i++) {
        const r = await deps.advanceWorldWeek.execute({ worldId, tickKey: `e2e-onboard-s2w2-${i}` });
        thirdRollover = r.weekRolledOver;
      }
      expect(thirdRollover).toBe(true);
      expect(await deps.managerLadder.scoreFor(ManagerId('m-onboard'))).toBeCloseTo(
        afterSecond * factor * factor - penalty,
      );
    } finally {
      await deps.worlds.save(originalWorld!);
    }
  });

  it('registers this week for a FUTURE week and is not penalized — while a genuinely idle manager is (the season-4 wrongful −500)', async () => {
    const worldId = WorldId('main');
    const originalWorld = await deps.worlds.findById(worldId);
    const ladderPolicy = new StandardManagerLadderPolicy();
    const factor = ladderPolicy.weeklyDecayFactor();
    const penalty = ladderPolicy.inactivityPenaltyPoints();
    const agingPolicy = new StandardAgingPolicy();
    try {
      // Mid-week day 4 of S1W52: still week 52. The rollover below ends
      // week 52, so "entries made during week 52" is exactly what the
      // inactivity check must count.
      await deps.worlds.save(
        GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 52 }, currentDay: 4, lastAppliedTick: null }),
      );

      const rosterPlayer = (id: string, managerId: ManagerId) => {
        const p = Player.hire(PlayerId(id), `Player ${id}`, 24 * 52, fixedAttributes(40), managerId, 'US', 100, { speed: 100, stamina: 100, strength: 100 }, 50, { season: 1, week: 1 });
        p.pullDomainEvents();
        return p;
      };
      await deps.players.save(rosterPlayer('keyed-active', ManagerId('m-keyed')));
      await deps.players.save(rosterPlayer('keyed-idle', ManagerId('m-idle')));

      // An event scheduled for the FUTURE week — the normal flow.
      await deps.openRegistration.execute({
        tournamentId: TournamentId('t-keyed-future'),
        tier: 'futures',
        surface: 'hard',
        weekScheduled: { season: 2, week: 1 },
        drawSize: 32,
      });

      // The active manager enters THROUGH THE REAL ROUTE during week 52.
      const entered = await app.inject({
        method: 'POST',
        url: '/tournaments/t-keyed-future/entrants',
        headers: { 'x-dev-manager-id': 'm-keyed' },
        payload: { playerId: 'keyed-active' },
      });
      expect(entered.statusCode).toBe(201);

      // The entry was stamped with the week it was MADE in (S1W52), not
      // the event's scheduled week (S2W1) — the honest key.
      const claimRows = await db.select().from(schema.managerEntryActivity);
      expect(claimRows).toEqual([
        expect.objectContaining({ managerId: 'm-keyed', season: 1, week: 52, playerId: 'keyed-active' }),
      ]);

      await deps.managerLadder.credit(ManagerId('m-keyed'), 1000);
      await deps.managerLadder.credit(ManagerId('m-idle'), 1000);

      // Tick until the week actually rolls over (world is at S1W52 day
      // 4, so three day ticks reach day 7 and the fourth rolls it).
      let rolled = false;
      for (let i = 0; i < 8 && !rolled; i++) {
        const r = await deps.advanceWorldWeek.execute({ worldId, tickKey: `e2e-keyed-${i}` });
        rolled = r.weekRolledOver;
      }
      expect(rolled).toBe(true);

      expect(await deps.managerLadder.scoreFor(ManagerId('m-keyed'))).toBeCloseTo(1000 * factor);
      // The idle manager's roster predates the week (managerSinceWeek
      // S1W1) and made no entry — the deduction applies.
      expect(await deps.managerLadder.scoreFor(ManagerId('m-idle'))).toBeCloseTo(1000 * factor - penalty);
    } finally {
      await deps.worlds.save(originalWorld!);
    }
  });

  it('the entry preview reads the SEASON-ANCHORED eligibility age, not the raw age (the live raw-729 / anchor-728 U14 case)', async () => {
    const agingService = new PlayerAgingService(new StandardAgingPolicy());
    const originalWorld = await deps.worlds.findById(WorldId('main'));
    try {
      // A player hired at exactly 14*52 = 728 weeks — the INCLUSIVE U14
      // edge (RankingBand.U14_MAX_AGE_WEEKS) — then aged one ordinary
      // mid-week tick: raw age 729 (which alone reads as U16), season
      // anchor still 728 (the real ITF "age as of January 1" rule).
      // This is exactly the state the season-4 agent hit: roster/profile
      // band displays said 'u14', the registration gate accepted U14
      // (both anchor-based), but the entry PREVIEW read the raw age and
      // refused every U14 event — the U14 rows vanished from the digest's
      // `canEnterNow` for 26 weeks while her u14 total sat frozen.
      const player = Player.hire(
        PlayerId('anchor-p'),
        'Anchor Player',
        728,
        fixedAttributes(40),
        ManagerId('m-anchor'),
        'BR',
        100,
        { speed: 100, stamina: 100, strength: 100 },
        50,
        { season: 1, week: 30 },
      );
      player.pullDomainEvents();
      agingService.advance(player);
      expect(player.ageInWeeks).toBe(729);
      expect(player.seasonAgeAnchorWeeks).toBe(728);
      await deps.players.save(player);

      // A genuinely open U14 event for the preview to (not) offer.
      await deps.openRegistration.execute({
        tournamentId: TournamentId('t-anchor-u14'),
        tier: 'j30',
        surface: 'clay',
        weekScheduled: { season: 1, week: 52 },
        drawSize: 16,
        ageBand: 'u14',
      });

      const list = await app.inject({
        method: 'GET',
        url: '/tournaments?status=open&playerId=anchor-p',
        headers: { 'x-dev-manager-id': 'm-anchor' },
      });
      expect(list.statusCode).toBe(200);
      const row = (list.json() as Array<{ id: string; ageBand: string | null; ageEligible?: boolean }>).find(
        (t) => t.id === 't-anchor-u14',
      );
      // The preview and the prove-it POST below must agree — both read
      // the anchor, so the raw 729 no longer hides the U14 row.
      expect(row?.ageEligible).toBe(true);

      // And the registration gate really does accept it, so the preview
      // is not just self-consistent with a refusal.
      const entered = await app.inject({
        method: 'POST',
        url: '/tournaments/t-anchor-u14/entrants',
        headers: { 'x-dev-manager-id': 'm-anchor' },
        payload: { playerId: 'anchor-p' },
      });
      expect(entered.statusCode).toBe(201);
      const saved = await deps.tournaments.findById(TournamentId('t-anchor-u14'));
      expect(saved!.entrants.map((e) => e.playerId as string)).toContain('anchor-p');
    } finally {
      await deps.worlds.save(originalWorld!);
    }
  });

  it('a player ranked top-16 in two junior bands takes ONE juniorMasters invitation — the highest band — and the freed place is reallocated, not dropped (design item 2, real Postgres)', async () => {
    const worldId = WorldId('main');
    const originalWorld = await deps.worlds.findById(worldId);
    const agingPolicy = new StandardAgingPolicy();
    try {
      // Park the world at S1W50: the next generated week is 51, the
      // once-a-season juniorMasters week (see the junior schedule policy).
      await deps.worlds.save(
        GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 50 }, currentDay: 1, lastAppliedTick: null }),
      );

      const saveRankedPlayer = async (id: string, ageWeeks: number) => {
        await deps.players.save(
          Player.generateFillOnly(
            PlayerId(id),
            `Player ${id}`,
            ageWeeks,
            agingPolicy.stageForAge(ageWeeks),
            fixedAttributes(40),
            'BR',
            70,
            { speed: 70, stamina: 70, strength: 70 },
          ),
        );
      };
      const rank = (playerId: string, ageBand: 'u14' | 'u16' | 'u18', points: number) => ({
        playerId: PlayerId(playerId),
        tournamentId: TournamentId(`masters-rank-${playerId}-${ageBand}`),
        tier: 'j100' as const,
        ageBand,
        points,
        weekEarned: { season: 1, week: 30 },
      });

      // "dual" is top-ranked in BOTH the U16 and U18 ladders.
      await saveRankedPlayer('dual', 16 * 52);
      for (let i = 1; i <= 16; i++) await saveRankedPlayer(`u18-p${i}`, 17 * 52);
      for (let i = 1; i <= 17; i++) await saveRankedPlayer(`u16-p${i}`, 15 * 52);

      await deps.rankingLedger.append(rank('dual', 'u18', 400));
      await deps.rankingLedger.append(rank('dual', 'u16', 400));
      for (let i = 1; i <= 16; i++) await deps.rankingLedger.append(rank(`u18-p${i}`, 'u18', 300 - i));
      for (let i = 1; i <= 17; i++) await deps.rankingLedger.append(rank(`u16-p${i}`, 'u16', 200 - i));

      const result = await deps.generateJuniorTournaments.execute({ worldId });
      expect(result.mastersHeld).toBe(2); // U18 + U16; U14 has nobody ranked

      const masters = (await deps.tournaments.findStarted()).filter((t) => t.tier === 'juniorMasters');
      const u18 = masters.find((t) => t.ageBand === 'u18')!;
      const u16 = masters.find((t) => t.ageBand === 'u16')!;
      const u18Ids = u18.entrants.map((e) => e.playerId as string);
      const u16Ids = u16.entrants.map((e) => e.playerId as string);

      // One invitation for "dual", in the highest band — and both fields
      // still exactly 16 strong: the U16 place went to the next-ranked
      // eligible player (u16-p16), not into the void.
      expect(u18Ids).toContain('dual');
      expect(u16Ids).not.toContain('dual');
      expect(u18.entrants).toHaveLength(16);
      expect(u16.entrants).toHaveLength(16);
      expect(u16Ids).toContain('u16-p16');
      expect(u16Ids).not.toContain('u16-p17');
    } finally {
      // The suite's shared world must be restored for every other test.
      await deps.worlds.save(originalWorld!);
    }
  });

  it('surfaces doubles titles and recent doubles results to the digest feed and the API, reveal-gated like singles', async () => {
    const agingPolicy = new StandardAgingPolicy();
    const freeAt = (id: string, ageWeeks = 20 * 52) =>
      Player.generateFillOnly(
        PlayerId(id),
        `Player ${id}`,
        ageWeeks,
        agingPolicy.stageForAge(ageWeeks),
        fixedAttributes(40),
        'BR',
        70,
        { speed: 70, stamina: 70, strength: 70 },
      );
    await deps.players.save(freeAt('dig-main'));
    await deps.players.save(freeAt('dig-partner'));
    await deps.players.save(freeAt('dig-opp-a'));
    await deps.players.save(freeAt('dig-opp-b'));

    // A real doubles title (the partner is the interesting half).
    await db.insert(schema.doublesTitles).values({
      tournamentId: 'dig-title-t',
      playerA: PlayerId('dig-main'),
      playerB: PlayerId('dig-partner'),
      tier: 'challenger',
      ageBand: null,
      seasonEarned: 1,
      weekEarned: 4,
    });

    await db.insert(schema.tournaments).values([
      { id: 'dig-air', name: 'Digested Air Open', tier: 'challenger', surface: 'hard', seasonScheduled: 1, weekScheduled: 5, drawSize: 16, doublesDrawSize: 8 },
      { id: 'dig-unaired', name: 'Digested Reveal Open', tier: 'challenger', surface: 'hard', seasonScheduled: 1, weekScheduled: 6, drawSize: 16, doublesDrawSize: 8 },
    ]);
    // A singles entry in each draw, plus a REAL ledger row for dig-air only:
    // the profile history's new `pointsEarned` must read the ledger value
    // for the concluded event and 0 (not undefined) for the other.
    await db.insert(schema.tournamentEntries).values([
      { tournamentId: 'dig-air', playerId: PlayerId('dig-main') },
      { tournamentId: 'dig-unaired', playerId: PlayerId('dig-main') },
    ]);
    await deps.rankingLedger.append({
      playerId: PlayerId('dig-main'),
      tournamentId: TournamentId('dig-air'),
      tier: 'challenger',
      ageBand: null,
      points: 90,
      weekEarned: { season: 1, week: 5 },
    });
    await db.insert(schema.tournamentDoublesPairs).values([
      { tournamentId: 'dig-air', pairId: 'dig-mine-air', playerA: PlayerId('dig-main'), playerB: PlayerId('dig-partner') },
      { tournamentId: 'dig-air', pairId: 'dig-opp-air', playerA: PlayerId('dig-opp-a'), playerB: PlayerId('dig-opp-b') },
      { tournamentId: 'dig-unaired', pairId: 'dig-mine-unaired', playerA: PlayerId('dig-main'), playerB: PlayerId('dig-partner') },
      { tournamentId: 'dig-unaired', pairId: 'dig-opp-unaired', playerA: PlayerId('dig-opp-a'), playerB: PlayerId('dig-opp-b') },
    ]);
    await db.insert(schema.tournamentDoublesMatches).values([
      // Decided AND fully aired -> a real recent doubles result.
      {
        tournamentId: 'dig-air',
        draw: 'main',
        roundNumber: 1,
        matchIndex: 0,
        entrantA: 'dig-mine-air',
        entrantB: 'dig-opp-air',
        winnerId: 'dig-mine-air',
        loserId: 'dig-opp-air',
        setScores: [{ winnerGames: 6, loserGames: 3 }],
        scheduledStartAt: new Date(Date.now() - 60 * 60_000),
        revealSeconds: 900,
      },
      // Decided but still inside its reveal window -> hidden, exactly like
      // a singles result in the same state.
      {
        tournamentId: 'dig-unaired',
        draw: 'main',
        roundNumber: 1,
        matchIndex: 0,
        entrantA: 'dig-mine-unaired',
        entrantB: 'dig-opp-unaired',
        winnerId: 'dig-opp-unaired',
        loserId: 'dig-mine-unaired',
        setScores: [{ winnerGames: 6, loserGames: 4 }],
        scheduledStartAt: new Date(Date.now() + 60 * 60_000),
        revealSeconds: 900,
      },
    ]);
    // A singles match for the same player, so "singles unchanged" is
    // proven in the same read.
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'dig-air',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('dig-main'),
      entrantB: PlayerId('dig-opp-a'),
      winnerId: PlayerId('dig-main'),
      loserId: PlayerId('dig-opp-a'),
      setScores: [{ winnerGames: 6, loserGames: 1 }],
      scheduledStartAt: new Date(Date.now() - 60 * 60_000),
      revealSeconds: 900,
    });

    const matchesRes = await app.inject({ method: 'GET', url: '/players/dig-main/current-matches' });
    expect(matchesRes.statusCode).toBe(200);
    const matches = matchesRes.json() as {
      recent: Array<Record<string, unknown>>;
      recentDoubles: Array<Record<string, unknown>>;
    };
    // Existing singles behaviour: exactly the aired singles match, untouched.
    expect(matches.recent).toHaveLength(1);
    expect(matches.recent[0]).toMatchObject({ tournamentId: 'dig-air', result: 'win', opponentName: 'Player dig-opp-a' });
    // The new doubles half: the aired match only; the revealing one is hidden.
    expect(matches.recentDoubles).toHaveLength(1);
    expect(matches.recentDoubles[0]).toMatchObject({
      tournamentId: 'dig-air',
      roundNumber: 1,
      result: 'win',
      opponentId: 'dig-opp-air',
      opponentName: 'Player dig-opp-a & Player dig-opp-b',
      opponentNationality: 'BR',
    });
    expect(matches.recentDoubles[0].setScores).toEqual([{ winnerGames: 6, loserGames: 3 }]);

    const profileRes = await app.inject({ method: 'GET', url: '/players/dig-main/profile' });
    expect(profileRes.statusCode).toBe(200);
    const profile = profileRes.json() as {
      doublesTitles: Array<Record<string, unknown>>;
      tournamentHistory: Array<{ tournamentId: string; pointsEarned: number }>;
    };
    expect(profile.doublesTitles).toHaveLength(1);
    expect(profile.doublesTitles[0]).toMatchObject({
      tournamentId: 'dig-title-t',
      partnerId: 'dig-partner',
      partnerName: 'Player dig-partner',
    });
    // pointsEarned (design item 1): the real ledger value, never re-derived.
    expect(profile.tournamentHistory.find((h) => h.tournamentId === 'dig-air')?.pointsEarned).toBe(90);
    expect(profile.tournamentHistory.find((h) => h.tournamentId === 'dig-unaired')?.pointsEarned).toBe(0);

    // The digest feed the season harness builds — via the EXACT production
    // mappers — now sees both the doubles title and the doubles result.
    const digestDoublesTitles = compactDoublesTitles(profile);
    expect(digestDoublesTitles).toHaveLength(1);
    expect(digestDoublesTitles[0].partnerName).toBe('Player dig-partner');
    const lastResults = compactLastResults(matches);
    expect(lastResults).toHaveLength(2);
    const byDiscipline = Object.fromEntries(lastResults.map((r) => [r.discipline, r]));
    expect(byDiscipline.singles.tournamentId).toBe('dig-air');
    expect(byDiscipline.doubles.tournamentId).toBe('dig-air');
    expect(byDiscipline.doubles.result).toBe('win');
  });

  it('pads a doubles field from RANKED free agents, not the pool youngest-first order (F3, real Postgres)', async () => {
    const agingPolicy = new StandardAgingPolicy();
    const freeAt = (id: string, ageWeeks: number) =>
      Player.generateFillOnly(
        PlayerId(id),
        `Player ${id}`,
        ageWeeks,
        agingPolicy.stageForAge(ageWeeks),
        fixedAttributes(40),
        'BR',
        70,
        { speed: 70, stamina: 70, strength: 70 },
      );
    // 14 young unranked fillers are saved FIRST, so the real
    // findFreeAgents() (youngest-first) would pick exactly these; the two
    // genuinely-ranked, older free agents come later in that order.
    for (let i = 1; i <= 14; i++) await deps.players.save(freeAt(`pad-young-${i}`, 18 * 52));
    await deps.players.save(freeAt('pad-ranked-a', 30 * 52));
    await deps.players.save(freeAt('pad-ranked-b', 31 * 52));
    await deps.rankingLedger.append({
      playerId: PlayerId('pad-ranked-a'),
      tournamentId: TournamentId('pad-rank-t-a'),
      tier: 'challenger',
      ageBand: null,
      points: 90,
      weekEarned: { season: 1, week: 52 },
    });
    await deps.rankingLedger.append({
      playerId: PlayerId('pad-ranked-b'),
      tournamentId: TournamentId('pad-rank-t-b'),
      tier: 'challenger',
      ageBand: null,
      points: 40,
      weekEarned: { season: 1, week: 52 },
    });

    const tournament = Tournament.open({
      name: 'Ranked Pad Open',
      id: TournamentId('t-ranked-pad'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 52 },
      drawSize: 16,
      doublesDrawSize: 8,
    });
    const a = freeAt('pad-pair-a', 26 * 52);
    const b = freeAt('pad-pair-b', 27 * 52);
    await deps.players.save(a);
    await deps.players.save(b);
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await deps.tournaments.save(tournament);
    await deps.doublesPairs.save(DoublesPair.activate(PairId('pad-pair'), a.id, b.id));

    const loaded = await deps.tournaments.findById(TournamentId('t-ranked-pad'));
    await deps.formDoublesDraw.form(loaded!);
    const formed = await deps.tournaments.findById(TournamentId('t-ranked-pad'));
    expect(formed!.hasDoublesDrawStarted).toBe(true);
    const usedIds = formed!.doublesPairs.flatMap((p) => [p.playerA, p.playerB]);
    // The two ranked free agents are IN the formed field; before the fix
    // the youngest-first padding excluded both (they were positions 15-16
    // of a 16-deep pool that only needed 14).
    expect(usedIds).toContain(PlayerId('pad-ranked-a'));
    expect(usedIds).toContain(PlayerId('pad-ranked-b'));
  });

  it('automatically promotes a real Brazilian qualifying registrant to a wild card, never a French one, driven against real Postgres data', async () => {
    const tournamentId = TournamentId('t-wildcard');
    const tournament = Tournament.open({
      name: 'Test Wild Card Field',
      id: tournamentId,
      tier: 'tour', // 2 wild card slots (WildCardPolicy), holds qualifying
      surface: 'hard',
      hostCountry: 'Brazil',
      weekScheduled: { season: 1, week: 51 },
      drawSize: 16,
      qualifyingDrawSize: 8,
      qualifierSlots: 2,
      wildCardSlots: 2,
    });
    // Two REAL registered qualifying entrants (below the direct-
    // acceptance cutoff, exactly what a manager's genuine registration
    // produces) — one shares the tournament's host country, one doesn't.
    tournament.registerEntrant({ playerId: PlayerId('wc-br'), seed: null, draw: 'qualifying', entryType: 'Q' });
    tournament.registerEntrant({ playerId: PlayerId('wc-fr'), seed: null, draw: 'qualifying', entryType: 'Q' });
    await deps.players.save(
      Player.hire(PlayerId('wc-br'), 'BR Player', 25 * 52, fixedAttributes(30), ManagerId('m-wc'), 'Brazil'),
    );
    await deps.players.save(
      Player.hire(PlayerId('wc-fr'), 'FR Player', 25 * 52, fixedAttributes(30), ManagerId('m-wc'), 'France'),
    );
    await deps.tournaments.save(tournament);

    // Drives applyWildCards via the real weekly sweep, wired through
    // composition.ts exactly as the worker calls it — this is a real
    // Postgres round trip, not an in-memory fake.
    await deps.startDueTournaments.execute({ worldId: WorldId('main') });

    const fetched = await app.inject({ method: 'GET', url: `/tournaments/${tournamentId}` });
    expect(fetched.statusCode).toBe(200);
    const dto = fetched.json();
    expect(dto.entrants.find((e: { playerId: string }) => e.playerId === 'wc-br')).toMatchObject({ entryType: 'WC' });
    expect(dto.entrants.find((e: { playerId: string }) => e.playerId === 'wc-fr')).toMatchObject({ entryType: 'Q' });
    expect(dto.wildCardSlots).toBe(2);
    expect(dto.wildCardSlotsTaken).toBe(1);
  });

  it('exposes mainDrawEntrants separately from entrants so a qualifying field can never make the count exceed the draw size', async () => {
    // The real bug this pins: the tournaments list and the bracket hero
    // showed `entrants.length` against `drawSize`, so a qualifying-tier
    // event (whose `entrants` covers BOTH draws) read e.g. "88/64". The
    // DTO now carries the main-draw count explicitly.
    const tournamentId = TournamentId('t-main-count');
    const tournament = Tournament.open({
      name: 'Test Main Entrant Count',
      id: tournamentId,
      tier: 'tour', // holds qualifying (32-ish), so the split is real
      surface: 'hard',
      hostCountry: null,
      weekScheduled: { season: 1, week: 51 },
      drawSize: 16,
      qualifyingDrawSize: 8,
      qualifierSlots: 2,
      wildCardSlots: 2,
    });
    tournament.registerEntrant({ playerId: PlayerId('mc-main'), seed: 1, draw: 'main', entryType: 'DA' });
    tournament.registerEntrant({ playerId: PlayerId('mc-q1'), seed: null, draw: 'qualifying', entryType: 'Q' });
    tournament.registerEntrant({ playerId: PlayerId('mc-q2'), seed: null, draw: 'qualifying', entryType: 'Q' });
    // tournament_entries has a real FK to players — the entrants must exist.
    for (const [pid, name] of [['mc-main', 'MC Main'], ['mc-q1', 'MC Q1'], ['mc-q2', 'MC Q2']] as const) {
      await deps.players.save(Player.hire(PlayerId(pid), name, 25 * 52, fixedAttributes(40), ManagerId('m-mc'), 'Spain'));
    }
    await deps.tournaments.save(tournament);

    const dto = (await app.inject({ method: 'GET', url: `/tournaments/${tournamentId}` })).json();
    // `entrants` covers both draws; `mainDrawEntrants` counts only the main one.
    expect(dto.entrants).toHaveLength(3);
    expect(dto.mainDrawEntrants).toBe(1);
    expect(dto.mainDrawEntrants).toBeLessThanOrEqual(dto.drawSize);
  });

  it('reports managerEntrants as a real, present 0 when nobody has entered (not absent)', async () => {
    // The grouped count only returns tournaments that HAVE a manager
    // entrant, so without the route's zero-fill the DTO field was ABSENT and
    // the picker showed no entrant line at all — exactly when a manager most
    // wants to know nobody has entered. Zero must be present; absent means
    // "this read never computed it".
    const tournamentId = TournamentId('t-zero-manager-entrants');
    await deps.tournaments.save(
      Tournament.open({
        name: 'Test Zero Manager Entrants',
        id: tournamentId,
        tier: 'futures',
        surface: 'hard',
        hostCountry: null,
        weekScheduled: { season: 1, week: 51 },
        drawSize: 16,
      }),
    );

    const dto = (await app.inject({ method: 'GET', url: `/tournaments/${tournamentId}` })).json();
    expect(dto.managerEntrants).toBe(0);
  });

  it('lists a manager roster (empty roster is 200 [], missing replay is 404)', async () => {
    expect((await app.inject({ method: 'GET', url: '/managers/m9/players', headers: { 'x-dev-manager-id': 'm9' } })).json()).toEqual([]);

    await hirePlayer('p1', 'm1');
    await hirePlayer('p2', 'm1');
    await hirePlayer('p3', 'm2');

    const roster = (await app.inject({ method: 'GET', url: '/managers/m1/players', headers: { 'x-dev-manager-id': 'm1' } })).json();
    expect(roster).toHaveLength(2);
    expect(roster.map((p: { id: string }) => p.id).sort()).toEqual(['p1', 'p2']);

    expect((await app.inject({ method: 'GET', url: '/match-logs/ghost.json' })).statusCode).toBe(404);
  });

  it('404s when simulating a match in a missing tournament', async () => {
    const response = await app.inject({ method: 'POST', url: '/tournaments/ghost/matches/1/0/simulate', headers: { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' } });
    expect(response.statusCode).toBe(404);
  });

  it('refuses the manual simulate override to a plain manager (it is an operator/dev action, not a player action)', async () => {
    // The player-facing bracket no longer renders a "Simulate" control, and the
    // route itself is admin-gated: a normal manager token must be refused even
    // though the same manager is perfectly entitled to GET the bracket.
    const response = await app.inject({
      method: 'POST',
      url: '/tournaments/t1/matches/1/0/simulate',
      headers: { 'x-dev-manager-id': 'm1' },
    });
    expect(response.statusCode).toBe(403);
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
      headers: { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' },
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
          headers: { 'x-internal-admin-token': process.env.INTERNAL_ADMIN_TOKEN ?? 'test-admin' },
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

    // The public standings board (GET /rankings/:band) must agree with
    // the per-player read above — same champion at rank 1, same total —
    // and requires no auth (unlike the manager leaderboard).
    const seniorBoard = await app.inject({ method: 'GET', url: '/rankings/senior' });
    expect(seniorBoard.statusCode).toBe(200);
    const seniorRows = seniorBoard.json();
    expect(seniorRows.band).toBe('senior');
    expect(seniorRows.standings[0]).toMatchObject({
      rank: 1,
      playerId: championId,
      points: championRanking.json().totalPoints,
    });
    expect(seniorRows.standings[0].name).toBe(`Player ${championId}`);
    for (let i = 1; i < seniorRows.standings.length; i++) {
      expect(seniorRows.standings[i - 1].points).toBeGreaterThanOrEqual(seniorRows.standings[i].points);
    }

    // The manager ladder must have credited the same event: managers
    // whose players earned points appear on the leaderboard, ordered by
    // score descending. This asserts the credit path end-to-end through
    // the real HTTP route, not just the use case.
    const leaderboard = await app.inject({ method: 'GET', url: '/managers/leaderboard', headers: { 'x-dev-manager-id': 'rm1' } });
    expect(leaderboard.statusCode).toBe(200);
    const board = leaderboard.json();
    expect(board.standings.length).toBeGreaterThan(0);
    for (let i = 1; i < board.standings.length; i++) {
      expect(board.standings[i - 1].score).toBeGreaterThanOrEqual(board.standings[i].score);
    }
    expect(board.standings[0].rank).toBe(1);
    // The champion's manager banked the single largest per-player result
    // (pointsFor(4)), so they must appear somewhere on the board.
    const championManager = `rm${Math.ceil(Number(championId!.replace('rp', '')) / 2)}`;
    expect(board.standings.some((r: { managerId: string }) => r.managerId === championManager)).toBe(true);
    // The caller (rm1) is echoed back with a self entry.
    expect(board.self.managerId).toBe('rm1');
  });

  it('reads the DOUBLES ladder via ?discipline=doubles, keeps the default body byte-shaped, and 400s an unknown discipline', async () => {
    await hirePlayer('dl-s', 'm-dl');
    await hirePlayer('dl-d', 'm-dl');
    await db.insert(schema.tournaments).values({
      id: 't-dl',
      name: 'Discipline Ladder Event',
      tier: 'challenger',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
    });
    await deps.rankingLedger.append({
      playerId: PlayerId('dl-s'),
      tournamentId: TournamentId('t-dl'),
      tier: 'challenger',
      ageBand: null,
      points: 100,
      weekEarned: { season: 1, week: 1 },
    });
    await deps.rankingLedger.append({
      playerId: PlayerId('dl-d'),
      tournamentId: TournamentId('t-dl'),
      tier: 'challenger',
      ageBand: null,
      points: 250,
      weekEarned: { season: 1, week: 1 },
      discipline: 'doubles',
    });

    // Default (no parameter): the singles board, with exactly the same
    // response shape as before doubles ladders existed.
    const singlesBoard = await app.inject({ method: 'GET', url: '/rankings/senior' });
    expect(singlesBoard.statusCode).toBe(200);
    const singlesBody = singlesBoard.json();
    expect(Object.keys(singlesBody).sort()).toEqual(['band', 'standings']);
    expect(singlesBody.standings.map((r: { playerId: string }) => r.playerId)).toEqual(['dl-s']);

    const doublesBoard = await app.inject({ method: 'GET', url: '/rankings/senior?discipline=doubles' });
    expect(doublesBoard.statusCode).toBe(200);
    expect(doublesBoard.json().standings.map((r: { playerId: string }) => r.playerId)).toEqual(['dl-d']);

    const invalid = await app.inject({ method: 'GET', url: '/rankings/senior?discipline=mixed' });
    expect(invalid.statusCode).toBe(400);

    // The profile exposes the live doubles standing beside the permanent
    // doubles peaks.
    const profile = await app.inject({ method: 'GET', url: '/players/dl-d/profile' });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().currentDoublesRankings.find((r: { band: string }) => r.band === 'senior')).toEqual({
      band: 'senior',
      totalPoints: 250,
      rank: 1,
    });
  });

  it('sells cosmetics for XP: the owned set round-trips, refusals are real, and the badge shows on the leaderboard (Batch 4B, F2)', async () => {
    const managerId = 'm-cosmetics';
    const headers = { 'x-dev-manager-id': managerId };
    // Fund the wallet BEFORE the first request (the starter grant only
    // applies to a genuinely new account, and this row already exists).
    await deps.managerXp.credit(ManagerId(managerId), 2_000);

    // The catalog + owned set (initially empty) + the real balance.
    const catalog = await app.inject({ method: 'GET', url: '/managers/cosmetics', headers });
    expect(catalog.statusCode).toBe(200);
    const catalogBody = catalog.json();
    expect(catalogBody.owned).toEqual([]);
    expect(catalogBody.badge).toBeNull();
    expect(catalogBody.xpBalance).toBe(2_000);
    expect(catalogBody.catalog.length).toBeGreaterThanOrEqual(9);
    expect(catalogBody.catalog.every((i: { price: number }) => typeof i.price === 'number' && i.price > 0)).toBe(true);

    // Buy a badge: XP is deducted and the unlock persists.
    const bought = await app.inject({
      method: 'POST',
      url: '/managers/cosmetics/purchase',
      headers,
      payload: { itemId: 'badge-star' },
    });
    expect(bought.statusCode).toBe(200);
    expect(bought.json()).toMatchObject({ itemId: 'badge-star', xpSpent: 200, xpBalance: 1_800 });
    expect(bought.json().owned).toContain('badge-star');

    // Re-buy refused; the balance is charged exactly once.
    const rebuy = await app.inject({
      method: 'POST',
      url: '/managers/cosmetics/purchase',
      headers,
      payload: { itemId: 'badge-star' },
    });
    expect(rebuy.statusCode).toBe(409);
    expect((rebuy.json() as { error: string }).error).toContain('already owned');
    expect((await app.inject({ method: 'GET', url: '/managers/cosmetics', headers })).json().xpBalance).toBe(1_800);

    // An unknown item is refused without touching the balance.
    const unknown = await app.inject({
      method: 'POST',
      url: '/managers/cosmetics/purchase',
      headers,
      payload: { itemId: 'no-such-item' },
    });
    expect(unknown.statusCode).toBe(409);
    expect((unknown.json() as { error: string }).error).toContain('Unknown cosmetic item');

    // An unaffordable item is refused with the real numbers.
    const poor = await app.inject({
      method: 'POST',
      url: '/managers/cosmetics/purchase',
      headers,
      payload: { itemId: 'celebration-gold' },
    });
    expect(poor.statusCode).toBe(409);
    expect((poor.json() as { error: string }).error).toContain('needs 2000, balance 1800');

    // The entitlement/sidebar read sees the same post-spend balance.
    const entitlement = await app.inject({ method: 'GET', url: `/managers/${managerId}/entitlement`, headers });
    expect(entitlement.json().xpBalance).toBe(1_800);

    // Design item 3: the season digest now carries the shop. The runner's
    // digest builder fetches this SAME GET /managers/cosmetics response
    // through the SAME production mapper — so a live response mapped by
    // `compactShop` (the exact function agentSeason.mjs calls) proves the
    // shop and the balance reach the digest. Four measured seasons ended
    // with 100k+ unspent XP and zero purchases because the affordance was
    // never visible; it now is.
    const digestShop = compactShop((await app.inject({ method: 'GET', url: '/managers/cosmetics', headers })).json());
    expect(digestShop.xpBalance).toBe(1_800);
    expect(digestShop.owned).toContain('badge-star');
    const star = digestShop.items.find((i) => i.itemId === 'badge-star')!;
    expect(star).toMatchObject({ owned: true, affordable: true, price: 200 });
    const gold = digestShop.items.find((i) => i.itemId === 'celebration-gold')!;
    expect(gold).toMatchObject({ owned: false, affordable: false });

    // The owned badge renders next to the name on the public leaderboard,
    // for the caller's own echoed row too.
    await deps.managerLadder.credit(ManagerId(managerId), 50);
    const board = await app.inject({ method: 'GET', url: '/managers/leaderboard', headers });
    expect(board.statusCode).toBe(200);
    const row = board.json().standings.find((r: { managerId: string }) => r.managerId === managerId);
    expect(row.badge).toEqual({ itemId: 'badge-star', glyph: '★', name: 'Star Badge' });
    expect(board.json().self.badge).toEqual({ itemId: 'badge-star', glyph: '★', name: 'Star Badge' });
    // A manager with no badge serializes null, not an empty object.
    const otherRow = board.json().standings.find((r: { managerId: string }) => r.managerId !== managerId);
    if (otherRow) expect(otherRow.badge).toBeNull();
  });

  it('a fired Masters Cup writes its ledger rows and title keyed on the CUP id — the tournament FK hazard is gone', async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `mc${i + 1}`);
    // Spread across 8 managers, two players each — the free roster cap is 2.
    for (let i = 0; i < ids.length; i++) {
      expect(await hirePlayer(ids[i], `m-mc${Math.floor(i / 2) + 1}`)).toBe(201);
    }
    await db.insert(schema.tournaments).values({
      id: 'mc-ranks',
      name: 'Masters Cup Rankings Event',
      tier: 'challenger',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
    });
    for (let i = 0; i < 8; i++) {
      await deps.rankingLedger.append({
        playerId: PlayerId(ids[i]),
        tournamentId: TournamentId('mc-ranks'),
        tier: 'challenger',
        ageBand: null,
        points: 500 - i,
        weekEarned: { season: 1, week: 1 },
      });
    }
    for (let i = 0; i < 8; i++) {
      await deps.doublesPairs.save(DoublesPair.activate(PairId(`mc-pair-${i}`), PlayerId(ids[i * 2]), PlayerId(ids[i * 2 + 1])));
    }

    const generated = await deps.generateMastersCup.execute({
      worldId: WorldId('main'),
      season: 1,
      weekScheduled: { season: 1, week: 52 },
      surface: 'hard',
    });
    expect(generated).not.toBeNull();

    // Decide every group match so the knockout can be seeded, then advance.
    const loaded = (await deps.mastersCups.findBySeason(1))!;
    for (let g = 0; g < loaded.singlesGroups.length; g++) {
      for (let m = 0; m < loaded.singlesGroups[g].matches.length; m++) {
        const match = loaded.singlesGroups[g].matches[m];
        loaded.recordSinglesGroupMatchOutcome(g, m, { winner: match.entrantA, loser: match.entrantB, setScores: [{ winnerGames: 6, loserGames: 1 }] });
      }
    }
    for (let g = 0; g < loaded.doublesGroups.length; g++) {
      for (let m = 0; m < loaded.doublesGroups[g].matches.length; m++) {
        const match = loaded.doublesGroups[g].matches[m];
        loaded.recordDoublesGroupMatchOutcome(g, m, { winner: match.entrantA, loser: match.entrantB, setScores: [{ winnerGames: 6, loserGames: 1 }] });
      }
    }
    await deps.mastersCups.save(loaded);
    await deps.advanceMastersCup.execute({ season: 1 });
    const seeded = (await deps.mastersCups.findBySeason(1))!;
    expect(seeded.hasKnockout).toBe(true);

    // Both singles semifinals + the final. Pre-fix, each ledger insert
    // violated `ranking_ledger_tournament_id_tournaments_id_fk` (the cup
    // id is not a tournaments row) and no row ever landed.
    for (const [roundNumber, matchIndex] of [[1, 0], [1, 1], [2, 0]] as const) {
      await deps.simulateMastersCupMatch.execute({
        matchId: MatchId(`mc-singles-${roundNumber}-${matchIndex}`),
        cupId: seeded.id,
        season: 1,
        discipline: 'singles',
        phase: 'knockout',
        roundNumber,
        matchIndex,
      });
    }
    const cupRows = await db.select().from(schema.rankingLedger).where(eq(schema.rankingLedger.tournamentId, seeded.id));
    const singlesValues = cupRows
      .filter((r) => r.discipline === 'singles')
      .map((r) => r.points)
      .sort((a, b) => a - b);
    expect(singlesValues).toEqual([450, 450, 900, 1500]);

    const titleRows = await db.select().from(schema.titles).where(eq(schema.titles.tournamentId, seeded.id));
    expect(titleRows).toHaveLength(1);
    expect(titleRows[0].playerId).toBe(cupRows.find((r) => r.points === 1500)!.playerId);

    // A doubles knockout match lands two rows of scaleDoublesPoints(450)
    // = 225, stamped 'doubles'.
    await deps.simulateMastersCupMatch.execute({
      matchId: MatchId('mc-doubles-1-0'),
      cupId: seeded.id,
      season: 1,
      discipline: 'doubles',
      phase: 'knockout',
      roundNumber: 1,
      matchIndex: 0,
    });
    const doublesRows = (await db.select().from(schema.rankingLedger).where(eq(schema.rankingLedger.tournamentId, seeded.id))).filter(
      (r) => r.discipline === 'doubles',
    );
    expect(doublesRows).toHaveLength(2);
    expect(doublesRows.every((r) => r.points === 225)).toBe(true);
  });

  it("defaults a player's ranking to unranked (rank: null, 0 points) when they haven't earned any yet", async () => {
    const response = await app.inject({ method: 'GET', url: '/players/never-earned-anything/ranking' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ playerId: 'never-earned-anything', totalPoints: 0, rank: null });
  });

  it('serves the roster-dashboard read model with rank, overall, and surfaces per player', async () => {
    await hirePlayer('dp1', 'dm1');
    await hirePlayer('dp2', 'dm1');

    const response = await app.inject({ method: 'GET', url: '/managers/dm1/roster-dashboard', headers: { 'x-dev-manager-id': 'dm1' } });
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

  it('sets a training-schedule entry with no week given, defaulting to the world current week, and it shows up as the resolved roster-dashboard focus', async () => {
    await hirePlayer('sched-dp1', 'sched-dm1');

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/players/sched-dp1/training-focus',
      headers: { 'x-dev-manager-id': 'sched-dm1' },
      payload: { focus: { kind: 'surface', surface: 'clay' } },
    });
    expect(putResponse.statusCode).toBe(200);
    // beforeAll seeds the world at season 1, week 52 — the same
    // "no week means starting right now" default SetTrainingScheduleUseCase applies.
    expect(putResponse.json()).toEqual({
      playerId: 'sched-dp1',
      effectiveFrom: { season: 1, week: 52 },
      focus: { kind: 'surface', surface: 'clay' },
    });

    const dashboard = await app.inject({ method: 'GET', url: '/managers/sched-dm1/roster-dashboard', headers: { 'x-dev-manager-id': 'sched-dm1' } });
    const entry = dashboard.json().find((e: { id: string }) => e.id === 'sched-dp1');
    expect(entry.trainingFocus).toEqual({ kind: 'surface', surface: 'clay' });
  });

  it('schedules a future-week focus without touching the current standing order, visible via GET training-schedule with the correct isExplicit flags', async () => {
    await hirePlayer('sched-dp2', 'sched-dm2');

    // Standing order starting now (week 52).
    await app.inject({
      method: 'PUT',
      url: '/players/sched-dp2/training-focus',
      headers: { 'x-dev-manager-id': 'sched-dm2' },
      payload: { focus: { kind: 'attribute', attribute: 'serve' } },
    });
    // A future entry, two weeks ahead (season 2, week 2 — 52 -> 1 -> 2).
    const future = await app.inject({
      method: 'PUT',
      url: '/players/sched-dp2/training-focus',
      headers: { 'x-dev-manager-id': 'sched-dm2' },
      payload: { focus: { kind: 'surface', surface: 'grass' }, week: { season: 2, week: 2 } },
    });
    expect(future.statusCode).toBe(200);
    expect(future.json()).toEqual({
      playerId: 'sched-dp2',
      effectiveFrom: { season: 2, week: 2 },
      focus: { kind: 'surface', surface: 'grass' },
    });

    const scheduleResponse = await app.inject({ method: 'GET', url: '/players/sched-dp2/training-schedule?weeks=4' });
    expect(scheduleResponse.statusCode).toBe(200);
    const weeks = scheduleResponse.json();
    expect(weeks).toEqual([
      { week: { season: 1, week: 52 }, focus: { kind: 'attribute', attribute: 'serve' }, isExplicit: true },
      { week: { season: 2, week: 1 }, focus: { kind: 'attribute', attribute: 'serve' }, isExplicit: false },
      { week: { season: 2, week: 2 }, focus: { kind: 'surface', surface: 'grass' }, isExplicit: true },
      { week: { season: 2, week: 3 }, focus: { kind: 'surface', surface: 'grass' }, isExplicit: false },
    ]);
  });

  it('rejects scheduling a training focus for a week before the world current week', async () => {
    await hirePlayer('sched-dp3', 'sched-dm3');

    const response = await app.inject({
      method: 'PUT',
      url: '/players/sched-dp3/training-focus',
      headers: { 'x-dev-manager-id': 'sched-dm3' },
      payload: { focus: { kind: 'surface', surface: 'clay' }, week: { season: 1, week: 51 } }, // one before the seeded current week (52)
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/past week/);
  });

  it("reports a manager's entitlement tier", async () => {
    const response = await app.inject({ method: 'GET', url: '/managers/some-free-manager/entitlement', headers: { 'x-dev-manager-id': 'some-free-manager' } });
    expect(response.statusCode).toBe(200);
    // xpBalance is STARTER_XP_BALANCE (500): the first request for a
    // never-seen manager creates the account, and account creation now
    // grants starter XP so a new manager can afford a first signing.
    expect(response.json()).toEqual({ managerId: 'some-free-manager', tier: 'free', customPlayerCredits: 0, xpBalance: 500 });
  });

  it('grants starter XP exactly once across concurrent first-requests (no inflated balance, no transient 0)', async () => {
    // Reproduces the real symptom: a brand-new manager's first page load
    // fires several parallel manager-scoped requests, each of which used
    // to miss the check-then-act account lookup and grant again. The
    // atomic create-and-grant must make every one of these responses
    // report exactly STARTER_XP_BALANCE (500) — never 0, never a multiple.
    const authSubject = `race-newcomer-${Date.now()}`;
    const headers = { 'x-dev-manager-id': authSubject };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ method: 'GET', url: '/me/entitlement', headers })),
    );

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses.map((r) => r.json().xpBalance)).toEqual(Array(8).fill(500));
  });

  it('lists available free-agent players and NEVER leaks the hidden potentialCeiling or physicalCeilings', async () => {
    const agingPolicy = new StandardAgingPolicy();
    await deps.players.save(
      Player.generateFillOnly(
        PlayerId('tp1'),
        'Pool Player',
        750,
        agingPolicy.stageForAge(750),
        fixedAttributes(50),
        'ES',
        91, // the real hidden number — must never appear in any response below
        // Distinctive, individually-identifiable values — must never
        // appear in any response below either.
        { speed: 77, stamina: 83, strength: 89 },
      ),
    );

    const listed = await app.inject({ method: 'GET', url: '/talent-pool' });
    expect(listed.statusCode).toBe(200);
    const candidates = listed.json().candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: 'tp1', name: 'Pool Player', nationality: 'ES', ageInWeeks: 750 });
    // Career signal + competing context are present and default honestly
    // for an unsigned player with no history — never a guess, never
    // omitted (the Scouting card reads these directly).
    expect(candidates[0]).toMatchObject({
      careerPrizeMoney: 0,
      titleCount: 0,
      // The tier-weighted figure travels WITH the count, never alone.
      titleWeight: 0,
      titlesByTier: {},
      currentTournament: null,
    });
    expect(candidates[0]).not.toHaveProperty('tier');
    expect(candidates[0]).not.toHaveProperty('potentialTier');
    expect(candidates[0].attributes.technical.serve).toBe(50); // current attributes stay precise, unfuzzed
    expect(listed.body).not.toContain('potentialCeiling');
    expect(listed.body).not.toContain('91'); // the real ceiling value itself, nowhere in the payload
    expect(listed.body).not.toContain('physicalCeilings');
    expect(listed.body).not.toContain('77'); // the real speed ceiling
    expect(listed.body).not.toContain('83'); // the real stamina ceiling
    expect(listed.body).not.toContain('89'); // the real strength ceiling

    await deps.managerXp.credit(ManagerId('m1'), AMPLE_XP_FOR_TESTS);
    const claimed = await app.inject({ method: 'POST', url: '/talent-pool/tp1/claim', headers: { 'x-dev-manager-id': 'm1' }, payload: { managerId: 'm1' } });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json().name).toBe('Pool Player');
    expect(claimed.body).not.toContain('potentialCeiling'); // claiming hands back a player DTO — same rule applies
    expect(claimed.body).not.toContain('91');
    expect(claimed.body).not.toContain('physicalCeilings');
    expect(claimed.body).not.toContain('77');
    expect(claimed.body).not.toContain('83');
    expect(claimed.body).not.toContain('89');

    const afterClaim = await app.inject({ method: 'GET', url: '/talent-pool' });
    expect(afterClaim.json().candidates).toEqual([]);
    expect(afterClaim.json().total).toBe(0);

    // A second claim attempt on the now-claimed candidate is a conflict
    // — m2 is funded too, so this genuinely exercises the "candidate
    // already claimed" path rather than incidentally masking it behind
    // an unrelated "insufficient XP" rejection.
    await deps.managerXp.credit(ManagerId('m2'), AMPLE_XP_FOR_TESTS);
    const secondClaim = await app.inject({ method: 'POST', url: '/talent-pool/tp1/claim', headers: { 'x-dev-manager-id': 'm2' }, payload: { managerId: 'm2' } });
    expect(secondClaim.statusCode).toBe(409);
  });

  it('shows a free agent’s titles tier-weighted — count AND weight together, never a tier-blind count', async () => {
    const agingPolicy = new StandardAgingPolicy();
    await deps.players.save(
      Player.generateFillOnly(PlayerId('tp-weighted'), 'Weighted Veteran', 30 * 52, agingPolicy.stageForAge(30 * 52), fixedAttributes(40), 'BR', 70, {
        speed: 70,
        stamina: 70,
        strength: 70,
      }),
    );
    // A major title needs a tournament row (titles FK to tournaments).
    await db.insert(schema.tournaments).values({
      id: 'tp-weighted-t1',
      name: 'Weighted Open',
      tier: 'major',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
      hasStarted: true,
    });
    await deps.titles.append({
      tournamentId: TournamentId('tp-weighted-t1'),
      playerId: PlayerId('tp-weighted'),
      tier: 'major',
      ageBand: null,
      weekEarned: { season: 1, week: 1 },
    });

    const listed = await app.inject({ method: 'GET', url: '/talent-pool' });
    expect(listed.statusCode).toBe(200);
    const dto = listed.json().candidates.find((c: { id: string }) => c.id === 'tp-weighted');
    expect(dto.titleCount).toBe(1);
    // The weight is the major's champion value, straight from the domain
    // points table — and the breakdown names the tier.
    expect(dto.titleWeight).toBe(2000);
    expect(dto.titlesByTier).toEqual({ major: 1 });
  });

  it('shows a committed free agent but refuses to sign them, and the DTO flag matches the enforcement', async () => {
    // The deliberate design rule: a free agent with an unfinished tournament
    // commitment appears in the pool (never hidden) but cannot be signed —
    // a signing is always clean, never inheriting an in-progress draw. The
    // DTO flag and the atomic claim share one predicate, so they agree.
    const agingPolicy = new StandardAgingPolicy();
    const stage = agingPolicy.stageForAge(20 * 52);
    const ceilings = { speed: 70, stamina: 70, strength: 70 };
    await deps.players.save(Player.generateFillOnly(PlayerId('tp-live'), 'Committed Free Agent', 20 * 52, stage, fixedAttributes(50), 'ES', 70, ceilings));
    await deps.players.save(Player.generateFillOnly(PlayerId('tp-live-opp'), 'Live Opponent', 20 * 52, stage, fixedAttributes(50), 'FR', 70, ceilings));
    await db.insert(schema.tournaments).values({
      id: 'tp-live-t1',
      name: 'Mid-Event Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
      hasStarted: true,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'tp-live-t1',
      playerId: PlayerId('tp-live'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });
    // An undecided match row: the tournament's main draw is not finished.
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'tp-live-t1',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('tp-live'),
      entrantB: PlayerId('tp-live-opp'),
      winnerId: null,
      loserId: null,
      setScores: null,
    });

    const listed = await app.inject({ method: 'GET', url: '/talent-pool' });
    expect(listed.statusCode).toBe(200);
    const dto = listed.json().candidates.find((c: { id: string }) => c.id === 'tp-live');
    expect(dto.currentTournament).toEqual({ id: 'tp-live-t1', name: 'Mid-Event Open' });
    expect(dto.signingBlocked).toBe(true);
    expect(dto.blockingCommitment).toEqual({ id: 'tp-live-t1', name: 'Mid-Event Open' });
    expect(dto.careerPrizeMoney).toBe(0);
    expect(dto.titleCount).toBe(0);
    expect(dto.titleWeight).toBe(0);
    expect(dto.titlesByTier).toEqual({});

    // The server refuses the signing with the plain-language reason.
    await deps.managerXp.credit(ManagerId('m1'), AMPLE_XP_FOR_TESTS);
    const refused = await app.inject({
      method: 'POST',
      url: '/talent-pool/tp-live/claim',
      headers: { 'x-dev-manager-id': 'm1' },
      payload: { managerId: 'm1' },
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toMatch(/unfinished tournament/);
    expect((await deps.players.findById(PlayerId('tp-live')))!.managerId).toBeNull();
  });

  it('pages the pool with limit/offset and filters signableOnly server-side, with honest totals', async () => {
    // The demand-sized pool is ~1,600 free agents — the response must be
    // one page, the filter must be applied in SQL (a signable-only page
    // can never contain a blocked row), and the counts must describe the
    // WHOLE pool, not just the page.
    const agingPolicy = new StandardAgingPolicy();
    const stage = agingPolicy.stageForAge(20 * 52);
    const ceilings = { speed: 70, stamina: 70, strength: 70 };
    for (let i = 0; i < 5; i++) {
      await deps.players.save(
        Player.generateFillOnly(PlayerId(`paged-${i}`), `Paged ${i}`, (18 + i) * 52, stage, fixedAttributes(50), 'ES', 70, ceilings),
      );
    }
    // The YOUNGEST (first, given youngest-first ordering) is committed
    // to an unstarted draw.
    await db.insert(schema.tournaments).values({
      id: 'paged-t1',
      name: 'Paging Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'paged-t1',
      playerId: PlayerId('paged-0'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });

    const first = await app.inject({ method: 'GET', url: '/talent-pool?limit=2&offset=0' });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json();
    expect(firstPage.candidates).toHaveLength(2);
    expect(firstPage.total).toBe(5); // all free agents match the default filter
    expect(firstPage.poolTotal).toBe(5);
    expect(firstPage.availableTotal).toBe(4);
    expect(firstPage.limit).toBe(2);
    expect(firstPage.offset).toBe(0);

    const second = await app.inject({ method: 'GET', url: '/talent-pool?limit=2&offset=2' });
    const secondPage = second.json();
    expect(secondPage.candidates).toHaveLength(2);
    const firstIds = firstPage.candidates.map((c: { id: string }) => c.id);
    const secondIds = secondPage.candidates.map((c: { id: string }) => c.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);

    const signable = await app.inject({ method: 'GET', url: '/talent-pool?signableOnly=true' });
    const signablePage = signable.json();
    expect(signablePage.candidates).toHaveLength(4);
    expect(signablePage.candidates.some((c: { id: string }) => c.id === 'paged-0')).toBe(false);
    expect(signablePage.candidates.every((c: { signingBlocked: boolean }) => c.signingBlocked === false)).toBe(true);
    expect(signablePage.total).toBe(4); // the filtered total
    expect(signablePage.availableTotal).toBe(4);
    expect(signablePage.poolTotal).toBe(5);
  });

  it('signs a free agent whose only tournament has FINISHED — the pool is not shrunk forever', async () => {
    const agingPolicy = new StandardAgingPolicy();
    const stage = agingPolicy.stageForAge(20 * 52);
    const ceilings = { speed: 70, stamina: 70, strength: 70 };
    await deps.players.save(Player.generateFillOnly(PlayerId('tp-done'), 'Finished Free Agent', 20 * 52, stage, fixedAttributes(50), 'ES', 70, ceilings));
    await deps.players.save(Player.generateFillOnly(PlayerId('tp-done-opp'), 'Done Opponent', 20 * 52, stage, fixedAttributes(50), 'FR', 70, ceilings));
    await db.insert(schema.tournaments).values({
      id: 'tp-done-t1',
      name: 'Concluded Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
      hasStarted: true,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'tp-done-t1',
      playerId: PlayerId('tp-done'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });
    // The main draw's final is decided -> the tournament is FINISHED.
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'tp-done-t1',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('tp-done'),
      entrantB: PlayerId('tp-done-opp'),
      winnerId: PlayerId('tp-done-opp'),
      loserId: PlayerId('tp-done'),
      setScores: [{ winnerGames: 6, loserGames: 4 }],
    });

    const listed = await app.inject({ method: 'GET', url: '/talent-pool' });
    const dto = listed.json().candidates.find((c: { id: string }) => c.id === 'tp-done');
    expect(dto.signingBlocked).toBe(false);
    expect(dto.blockingCommitment).toBeNull();

    await deps.managerXp.credit(ManagerId('m1'), AMPLE_XP_FOR_TESTS);
    const claimed = await app.inject({
      method: 'POST',
      url: '/talent-pool/tp-done/claim',
      headers: { 'x-dev-manager-id': 'm1' },
      payload: { managerId: 'm1' },
    });
    expect(claimed.statusCode).toBe(201);
    expect((claimed.json() as { managerId: string }).managerId).toBe('m1');
  });

  it('cancelling a permanently-stuck draw round-trips through real Postgres and releases its free agent through the real claim route', async () => {
    // The P1-C1/C2 end-to-end: a never-started, never-seeded draw (so its
    // main draw will never exist) whose entry locks a free agent out of
    // the signing pool forever. Cancelling it must (a) persist the
    // terminal state, (b) stop the pool marking the player blocked, and
    // (c) let the real atomic claim through.
    const agingPolicy = new StandardAgingPolicy();
    const stage = agingPolicy.stageForAge(20 * 52);
    const ceilings = { speed: 70, stamina: 70, strength: 70 };
    await deps.players.save(Player.generateFillOnly(PlayerId('tp-cancel'), 'Stuck Free Agent', 20 * 52, stage, fixedAttributes(50), 'ES', 70, ceilings));
    await db.insert(schema.tournaments).values({
      id: 'tp-cancel-t1',
      name: 'Stuck Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
      hasStarted: false, // never seeded — entries only
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'tp-cancel-t1',
      playerId: PlayerId('tp-cancel'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });

    const before = await app.inject({ method: 'GET', url: '/talent-pool?signableOnly=true' });
    expect(before.json().candidates.some((c: { id: string }) => c.id === 'tp-cancel')).toBe(false);
    const blockedList = await app.inject({ method: 'GET', url: '/talent-pool' });
    const blockedDto = blockedList.json().candidates.find((c: { id: string }) => c.id === 'tp-cancel');
    expect(blockedDto.signingBlocked).toBe(true);
    expect(blockedDto.blockingCommitment).toEqual({ id: 'tp-cancel-t1', name: 'Stuck Open' });

    await deps.managerXp.credit(ManagerId('m1'), AMPLE_XP_FOR_TESTS);
    const refused = await app.inject({
      method: 'POST',
      url: '/talent-pool/tp-cancel/claim',
      headers: { 'x-dev-manager-id': 'm1' },
      payload: { managerId: 'm1' },
    });
    expect(refused.statusCode).toBe(409);

    // Cancel through the real repository round-trip (the same domain call
    // StartDueTournamentsUseCase makes past its grace window).
    const stuck = (await deps.tournaments.findById(TournamentId('tp-cancel-t1')))!;
    stuck.cancel('The draw could not be filled in time');
    await deps.tournaments.save(stuck);

    const reloaded = (await deps.tournaments.findById(TournamentId('tp-cancel-t1')))!;
    expect(reloaded.isCancelled).toBe(true);
    expect(reloaded.cancelReason).toBe('The draw could not be filled in time');
    expect(reloaded.entrants.map((e) => e.playerId as string)).toEqual(['tp-cancel']); // entries KEPT

    // The DTO says it, visibly (P1-C3).
    const detail = await app.inject({ method: 'GET', url: '/tournaments/tp-cancel-t1' });
    expect(detail.json().cancelled).toBe(true);
    expect(detail.json().cancelReason).toBe('The draw could not be filled in time');
    // And a cancelled draw is not offered as open for registration.
    const open = await app.inject({ method: 'GET', url: '/tournaments?status=open' });
    expect(open.json().some((t: { id: string }) => t.id === 'tp-cancel-t1')).toBe(false);

    // The planner MARKS it rather than hiding it: the entry is still the
    // player's real history, clearly labelled cancelled. The default
    // planner window starts at the world's week (S1 W52), so schedule
    // the draw in W52 for this read.
    await db
      .update(schema.tournaments)
      .set({ seasonScheduled: 1, weekScheduled: 52 })
      .where(eq(schema.tournaments.id, 'tp-cancel-t1'));
    const planner = await app.inject({ method: 'GET', url: '/players/tp-cancel/entry-planner' });
    const planned = planner.json().flatMap((w: { entries: Array<{ id: string }> }) => w.entries).find((t: { id: string }) => t.id === 'tp-cancel-t1');
    expect(planned).toBeDefined();
    expect(planned.cancelled).toBe(true);
    expect(planned.cancelReason).toBe('The draw could not be filled in time');
    expect(planned.hasStarted).toBe(false);

    // The pool now offers them, and the real atomic claim succeeds.
    const after = await app.inject({ method: 'GET', url: '/talent-pool?signableOnly=true' });
    const dto = after.json().candidates.find((c: { id: string }) => c.id === 'tp-cancel');
    expect(dto.signingBlocked).toBe(false);
    expect(dto.blockingCommitment).toBeNull();

    const claimed = await app.inject({
      method: 'POST',
      url: '/talent-pool/tp-cancel/claim',
      headers: { 'x-dev-manager-id': 'm1' },
      payload: { managerId: 'm1' },
    });
    expect(claimed.statusCode).toBe(201);
    expect((claimed.json() as { managerId: string }).managerId).toBe('m1');
  });

  it('entry-planner ?pastWeeks includes live entries from a past-labelled week; the default window excludes them (agent-season D)', async () => {
    // The reported bug: a two-week major's matches play into the following
    // week, and week-2 juniors that played in week 3 vanished from the
    // digest's pendingEntries — the planner window started at "now" and a
    // past-labelled (but still live) event was never returned at all.
    const agingPolicy = new StandardAgingPolicy();
    await deps.players.save(
      Player.generateFillOnly(
        PlayerId('past-entry-p'),
        'Past Entry',
        24 * 52,
        agingPolicy.stageForAge(24 * 52),
        fixedAttributes(35),
        'US',
      ),
    );
    const past = Tournament.open({
      name: 'Past Labelled Major',
      id: TournamentId('t-past-label'),
      tier: 'major',
      surface: 'hard',
      weekScheduled: { season: 1, week: 50 }, // world is S1W52
      drawSize: 32,
    });
    past.registerEntrant({ playerId: PlayerId('past-entry-p'), seed: null });
    await deps.tournaments.save(past);

    const defaultWindow = await app.inject({ method: 'GET', url: '/players/past-entry-p/entry-planner' });
    expect(defaultWindow.statusCode).toBe(200);
    const defaultIds = defaultWindow
      .json()
      .flatMap((w: { entries: Array<{ id: string }> }) => w.entries)
      .map((t: { id: string }) => t.id);
    expect(defaultIds).not.toContain('t-past-label');

    const withPast = await app.inject({ method: 'GET', url: '/players/past-entry-p/entry-planner?weeks=3&pastWeeks=2' });
    expect(withPast.statusCode).toBe(200);
    const weeks = withPast.json();
    expect(weeks[0].week).toEqual({ season: 1, week: 50 });
    const pastIds = weeks
      .flatMap((w: { entries: Array<{ id: string }> }) => w.entries)
      .map((t: { id: string }) => t.id);
    expect(pastIds).toContain('t-past-label');

    const invalid = await app.inject({ method: 'GET', url: '/players/past-entry-p/entry-planner?pastWeeks=9' });
    expect(invalid.statusCode).toBe(400);
  });

  it('rejects creating a custom player for a non-Pro manager', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/players/custom',
      headers: { 'x-dev-manager-id': 'free-manager' },
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
      headers: { 'x-dev-manager-id': 'pro-manager' },
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

    const entitlement = await app.inject({ method: 'GET', url: '/managers/pro-manager/entitlement', headers: { 'x-dev-manager-id': 'pro-manager' } });
    expect(entitlement.json().customPlayerCredits).toBe(1); // spent exactly one of the two granted

    // A second and third create: the second still has a credit, the
    // third has none left.
    const second = await app.inject({
      method: 'POST',
      url: '/players/custom',
      headers: { 'x-dev-manager-id': 'pro-manager' },
      payload: { managerId: 'pro-manager', name: 'Second Kid', nationality: 'FR' },
    });
    expect(second.statusCode).toBe(201);

    const third = await app.inject({
      method: 'POST',
      url: '/players/custom',
      headers: { 'x-dev-manager-id': 'pro-manager' },
      payload: { managerId: 'pro-manager', name: 'Third Kid', nationality: 'FR' },
    });
    expect(third.statusCode).toBe(409);
  });

  it('two concurrent singles registration POSTs for the same tournament both land, and a duplicate retry is refused (item 2.2)', async () => {
    expect(await hirePlayer('race-a', 'm-race-1')).toBe(201);
    expect(await hirePlayer('race-b', 'm-race-2')).toBe(201);

    await deps.tournaments.save(
      Tournament.open({
        name: 'Race Open Singles',
        id: TournamentId('t-race-singles'),
        tier: 'challenger',
        surface: 'hard',
        weekScheduled: { season: 1, week: 52 },
        drawSize: 16,
      }),
    );

    // Two DIFFERENT players, same tournament, fired together — exactly
    // the interleaving that used to make the second save lose to the
    // optimistic lock and silently drop the entry.
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/tournaments/t-race-singles/entrants',
        headers: { 'x-dev-manager-id': 'm-race-1' },
        payload: { playerId: 'race-a' },
      }),
      app.inject({
        method: 'POST',
        url: '/tournaments/t-race-singles/entrants',
        headers: { 'x-dev-manager-id': 'm-race-2' },
        payload: { playerId: 'race-b' },
      }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);

    const fetched = await app.inject({ method: 'GET', url: '/tournaments/t-race-singles' });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().entrants.map((e: { playerId: string }) => e.playerId).sort()).toEqual(['race-a', 'race-b']);

    // A retried duplicate for an already-entered player is a rule
    // refusal (already registered), never a second row.
    const duplicate = await app.inject({
      method: 'POST',
      url: '/tournaments/t-race-singles/entrants',
      headers: { 'x-dev-manager-id': 'm-race-1' },
      payload: { playerId: 'race-a' },
    });
    expect(duplicate.statusCode).toBe(409);
    const refetched = await app.inject({ method: 'GET', url: '/tournaments/t-race-singles' });
    expect(refetched.json().entrants.filter((e: { playerId: string }) => e.playerId === 'race-a')).toHaveLength(1);
  });

  it('two concurrent DOUBLES registration POSTs for the same tournament both land, and a duplicate retry is refused (item 2.2)', async () => {
    expect(await hirePlayer('race-d1', 'm-race-d1')).toBe(201);
    expect(await hirePlayer('race-d2', 'm-race-d2')).toBe(201);

    await deps.tournaments.save(
      Tournament.open({
        name: 'Race Open Doubles',
        id: TournamentId('t-race-doubles'),
        tier: 'challenger',
        surface: 'hard',
        weekScheduled: { season: 1, week: 52 },
        drawSize: 16,
        doublesDrawSize: 8,
      }),
    );

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/tournaments/t-race-doubles/doubles-entrants',
        headers: { 'x-dev-manager-id': 'm-race-d1' },
        payload: { playerId: 'race-d1' },
      }),
      app.inject({
        method: 'POST',
        url: '/tournaments/t-race-doubles/doubles-entrants',
        headers: { 'x-dev-manager-id': 'm-race-d2' },
        payload: { playerId: 'race-d2' },
      }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);

    const fetched = await app.inject({ method: 'GET', url: '/tournaments/t-race-doubles' });
    expect(fetched.json().doublesEntrants.sort()).toEqual(['race-d1', 'race-d2']);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/tournaments/t-race-doubles/doubles-entrants',
      headers: { 'x-dev-manager-id': 'm-race-d1' },
      payload: { playerId: 'race-d1' },
    });
    expect(duplicate.statusCode).toBe(409);
    const refetched = await app.inject({ method: 'GET', url: '/tournaments/t-race-doubles' });
    expect(refetched.json().doublesEntrants.filter((id: string) => id === 'race-d1')).toHaveLength(1);
  });

  it('a lost optimistic-lock race is retried and the entry lands — forced through a first-save failure, against real Postgres (item 2.2)', async () => {
    expect(await hirePlayer('race-retry', 'm-race-retry')).toBe(201);
    await deps.tournaments.save(
      Tournament.open({
        name: 'Retry Open',
        id: TournamentId('t-race-retry'),
        tier: 'challenger',
        surface: 'hard',
        weekScheduled: { season: 1, week: 52 },
        drawSize: 16,
      }),
    );

    // The real repository, wrapped so the FIRST save throws the exact
    // conflict a concurrent writer produces. Without the retry wrapper
    // this would propagate (route 409) and the entry would be lost; with
    // it, the flow reloads and re-applies.
    const flaky = new FlakyFirstSaveTournamentRepository(deps.tournaments as unknown as TournamentRepository);
    const useCase = new RegisterEntrantUseCase(flaky, deps.players, new BracketGenerator());

    await useCase.execute({ tournamentId: TournamentId('t-race-retry'), playerId: PlayerId('race-retry') });

    const reloaded = await deps.tournaments.findById(TournamentId('t-race-retry'));
    expect(reloaded!.entrants.map((e) => e.playerId)).toContain(PlayerId('race-retry'));
  });

  it('awards doubles ledger points to the side that ACTUALLY won, in both orientations, against real Postgres (item 2.3)', async () => {
    // A deterministic slot-winner simulator lets both orientations be
    // pinned: side A wins once, side B wins once. The old bug always
    // attributed the winner's value to whichever pair sat in the
    // entrantA SLOT, so the side-B case is the regression.
    const simulators = { A: new FixedSlotWinnerSimulator('A'), B: new FixedSlotWinnerSimulator('B') } as const;

    for (const side of ['A', 'B'] as const) {
      const tournamentId = TournamentId(`t-doubles-award-${side}`);
      const agingPolicy = new StandardAgingPolicy();
      const playerIds = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'd2', 'e1', 'e2', 'f1', 'f2', 'g1', 'g2', 'h1', 'h2'];
      for (const id of playerIds) {
        await deps.players.save(
          Player.generateFillOnly(PlayerId(`${side}-${id}`), `${side} ${id}`, 24 * 52, agingPolicy.stageForAge(24 * 52), fixedAttributes(40), 'US'),
        );
      }

      const tournament = Tournament.open({
        name: `Doubles Award ${side}`,
        id: tournamentId,
        tier: 'challenger',
        surface: 'hard',
        weekScheduled: { season: 1, week: 52 },
        drawSize: 16,
        doublesDrawSize: 8,
      });
      const pairKeys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      const pairs = pairKeys.map((key) => ({
        pairId: PairId(`${side}-pair-${key}`),
        playerA: PlayerId(`${side}-${key}1`),
        playerB: PlayerId(`${side}-${key}2`),
        chemistry: 0,
      }));
      tournament.startDoublesWithBracket(
        pairs,
        new BracketGenerator().generate(pairs.map((p) => ({ playerId: p.pairId, seed: null })), 8),
      );
      tournament.pullDomainEvents();
      await deps.tournaments.save(tournament);

      const scheduled = tournament.getDoublesScheduledMatch(1, 0);
      const useCase = new SimulateDoublesMatchUseCase(
        deps.tournaments,
        deps.players,
        simulators[side],
        new StandardDoublesPairPolicy(),
        deps.matchLogs,
        new NoopEventPublisherForDoubles(),
        new BracketGenerator(),
        new StandardRankingPointsTable(),
        deps.rankingLedger,
        new StandardManagerXpPolicy(),
        deps.managerXp,
        new StandardManagerLadderPolicy(),
        deps.managerLadder,
        deps.worlds,
        WorldId('main'),
        new StandardPlayerDevelopmentPolicy(),
        deps.doublesPairs,
        new DrizzleDoublesTitleRepository(db),
        new DrizzleDoublesPeakRankingRepository(db),
      );
      await useCase.execute({ matchId: MatchId(`t-doubles-award-${side}-r1-m0`), tournamentId, roundNumber: 1, matchIndex: 0 });

      const refreshed = (await deps.tournaments.findById(tournamentId))!;
      const slotA = refreshed.doublesPlayersFor(scheduled.entrantA)!;
      const slotB = refreshed.doublesPlayersFor(scheduled.entrantB)!;
      const winningPair = side === 'A' ? slotA : slotB;
      const losingPair = side === 'A' ? slotB : slotA;

      const doublesPoints = async (playerId: PlayerId): Promise<number[]> => {
        const rows = await db.select().from(schema.rankingLedger).where(eq(schema.rankingLedger.playerId, playerId));
        return rows.filter((row) => row.discipline === 'doubles').map((row) => row.points);
      };

      for (const id of [winningPair.playerA, winningPair.playerB]) {
        const points = await doublesPoints(id);
        expect(points.length).toBeGreaterThan(0);
        expect(Math.max(...points)).toBeGreaterThan(0);
      }
      for (const id of [losingPair.playerA, losingPair.playerB]) {
        expect(await doublesPoints(id)).toEqual([0]);
      }
    }
  });
});
