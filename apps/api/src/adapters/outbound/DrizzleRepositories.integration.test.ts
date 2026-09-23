import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { drawOf, entryTypeOf, ManagerId, PairId, PlayerId, TournamentId, TournamentEntrant } from '@tennis-manager/domain';
import { DoublesPair } from '@tennis-manager/domain';
import { MastersCup } from '@tennis-manager/domain';
import { WorldTeamCup } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import {
  PlayerAttributes,
  Skill,
  SurfaceAffinities,
} from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { Coach, CoachId } from '@tennis-manager/domain';
import {
  GameWorld,
  juniorEligibilityForAge,
  RANKING_WINDOW_WEEKS,
  RandomSource,
  RankingBand,
  StandardAgingPolicy,
  StandardPlayerGenerationPolicy,
  WorldId,
} from '@tennis-manager/domain';
import * as schema from '../../db/schema';
import {
  ConcurrentModificationError,
  EnsureFillOnlyPopulationUseCase,
  EventPublisherPort,
  FILL_ONLY_FLOORS,
  IdGeneratorPort,
  ManagerContactPort,
  RankPositionQuery,
  SendManagerDigestsUseCase,
  StartDueTournamentsUseCase,
} from '@tennis-manager/application';
import { testConnectionString } from '../../db/testConnection';
import { DrizzlePlayerRepository } from './DrizzlePlayerRepository';
import { DrizzleTrainingScheduleRepository } from './DrizzleTrainingScheduleRepository';
import { DrizzleTournamentRepository } from './DrizzleTournamentRepository';
import { DrizzleRankingLedgerRepository } from './DrizzleRankingLedgerRepository';
import { DrizzleManagerXpRepository } from './DrizzleManagerXpRepository';
import { DrizzleManagerAccountCreationAdapter } from './DrizzleManagerAccountCreationAdapter';
import { DrizzleTalentClaimAdapter } from './DrizzleTalentClaimAdapter';
import { DrizzleCoachConversionAdapter } from './DrizzleCoachConversionAdapter';
import { DrizzleWeeklyEntryGuardAdapter } from './DrizzleWeeklyEntryGuardAdapter';
import { DrizzleCoachRepository } from './DrizzleCoachRepository';
import { DrizzlePeakRankingRepository } from './DrizzlePeakRankingRepository';
import { DrizzleTitleRepository } from './DrizzleTitleRepository';
import { DrizzleDoublesPairRepository } from './DrizzleDoublesPairRepository';
import { DrizzleDoublesTitleRepository } from './DrizzleDoublesTitleRepository';
import { DrizzleDoublesPeakRankingRepository } from './DrizzleDoublesPeakRankingRepository';
import { DrizzleMastersCupRepository } from './DrizzleMastersCupRepository';
import { DrizzleWorldTeamCupRepository } from './DrizzleWorldTeamCupRepository';
import { DrizzleGameWorldRepository } from './DrizzleGameWorldRepository';
import { DrizzlePlayerMatchesQuery } from './DrizzlePlayerMatchesQuery';
import { DrizzlePlayerTournamentHistoryQuery } from './DrizzlePlayerTournamentHistoryQuery';
import { DrizzleNotificationDeliveryRepository } from './DrizzleNotificationDeliveryRepository';
import { DrizzleNotificationPreferenceRepository } from './DrizzleNotificationPreferenceRepository';
import { DrizzleManagerDigestQuery } from './DrizzleManagerDigestQuery';
import { LoggingNotificationAdapter } from './LoggingNotificationAdapter';

const connectionString = testConnectionString();

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

function attributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base + 1), backhand: Skill.of(base + 2), volley: Skill.of(base + 3) },
    physical: { speed: Skill.of(base + 4), stamina: Skill.of(base + 5), strength: Skill.of(base + 6) },
    mental: { consistency: Skill.of(base + 7), clutch: Skill.of(base + 8) },
    surfaceAffinities: SurfaceAffinities.initial().trainedOn('clay', 15),
  });
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
});

beforeEach(async () => {
  // Child tables first (FKs), then parents. ranking_ledger/titles have
  // FKs to both players and tournaments, so they have to go before
  // either; peak_rankings/training_schedule only reference players.
  // doubles_pairs references players, so it goes before players too.
  // Notification tables FK managers.id — before anything they reference.
  await db.delete(schema.notificationDeliveries);
  await db.delete(schema.managerNotificationStates);
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
  await db.delete(schema.players);
  await db.delete(schema.managerProgression); // no FKs, order doesn't matter
  await db.delete(schema.coaches); // no FKs, order doesn't matter
});

/** Round-trip tests compare entrant sets, not array order — the
 * domain never promises order is preserved (BracketGenerator seeds
 * off `seed`, never array position). */
function byPlayerId(a: { playerId: string }, b: { playerId: string }): number {
  return a.playerId.localeCompare(b.playerId);
}

/** What an in-memory entrant list looks like once it has been through
 * the database: sorted (see byPlayerId) and with an EXPLICIT entryType
 * and draw, since tournament_entries.entry_type/draw are NOT NULL
 * DEFAULT 'da'/'main' — a plain `{ playerId, seed }` entrant reads back
 * as a direct acceptance in the main draw rather than with those fields
 * absent. A real, disclosed round-trip detail, not a normalization that
 * hides a difference. */
function persistedEntrants(entrants: ReadonlyArray<TournamentEntrant>): TournamentEntrant[] {
  return [...entrants]
    .sort(byPlayerId)
    .map((entrant) => ({ ...entrant, entryType: entryTypeOf(entrant), draw: drawOf(entrant) }));
}

afterAll(async () => {
  await pool.end();
});

describe('DrizzlePlayerRepository', () => {
  const repository = new DrizzlePlayerRepository(db);

  it('round-trips a player through save and findById', async () => {
    const managerId = ManagerId('m1');
    const original = Player.hire(PlayerId('p1'), 'João Silva', 19 * 52, attributes(30), managerId, 'BR');
    original.applyMatchFatigue(12);
    original.applyMatchForm(7);
    original.pullDomainEvents(); // adapter persists state, not events

    await repository.save(original);
    const loaded = await repository.findById(PlayerId('p1'));

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('p1');
    expect(loaded!.name).toBe('João Silva');
    expect(loaded!.nationality).toBe('BR');
    expect(loaded!.managerId).toBe(managerId);
    expect(loaded!.ageInWeeks).toBe(19 * 52);
    expect(loaded!.stage).toBe('youth');
    expect(loaded!.fatigue).toBe(12);
    expect(loaded!.form).toBe(7);
    expect(loaded!.fillOnly).toBe(false);
    expect(loaded!.attributes.technical.serve.value).toBe(30);
    expect(loaded!.attributes.technical.volley.value).toBe(33);
    expect(loaded!.attributes.physical.stamina.value).toBe(35);
    expect(loaded!.attributes.mental.clutch.value).toBe(38);
    expect(loaded!.attributes.surfaceAffinities.get('clay')).toBe(35);
    expect(loaded!.attributes.surfaceAffinities.get('grass')).toBe(20);
    // Reconstitution must not re-emit lifecycle events.
    expect(loaded!.pullDomainEvents()).toHaveLength(0);
  });

  it('round-trips a fill-only player: no manager, fillOnly true, findAll() still includes it (unlike a manager-scoped query)', async () => {
    const fillOnly = Player.generateFillOnly(PlayerId('filler-1'), 'Filler One', 33 * 52, 'decline', attributes(30), 'AR');
    fillOnly.pullDomainEvents();

    await repository.save(fillOnly);
    const loaded = await repository.findById(PlayerId('filler-1'));

    expect(loaded).not.toBeNull();
    expect(loaded!.fillOnly).toBe(true);
    expect(loaded!.managerId).toBeNull();
    expect(loaded!.stage).toBe('decline');
    expect(loaded!.ageInWeeks).toBe(33 * 52);

    // findAll() (what AdvanceWorldWeekUseCase reads every tick) sees
    // it; findByManager() (what every manager-scoped route reads)
    // never can, since managerId is null — same isolation a released
    // player already gets, just for a different reason.
    expect((await repository.findAll()).some((p) => p.id === 'filler-1')).toBe(true);
    expect(await repository.findByManager(ManagerId('m1'))).toHaveLength(0);
  });

  it('round-trips potentialCeiling (hidden training-growth cap), defaulting to 100 when not explicitly set', async () => {
    const withCeiling = Player.hire(PlayerId('p-ceiling'), 'Ceiling Test', 19 * 52, attributes(30), ManagerId('m1'), 'XX', 62);
    await repository.save(withCeiling);
    expect((await repository.findById(PlayerId('p-ceiling')))!.potentialCeiling).toBe(62);

    const withoutCeiling = Player.hire(PlayerId('p-default'), 'Default Test', 19 * 52, attributes(30), ManagerId('m1'));
    await repository.save(withoutCeiling);
    expect((await repository.findById(PlayerId('p-default')))!.potentialCeiling).toBe(100);
  });

  it('round-trips physicalCeilings (hidden per-attribute training caps), defaulting to 100 each when not explicitly set', async () => {
    const withCeilings = Player.hire(
      PlayerId('p-physceil'),
      'Physical Ceiling Test',
      19 * 52,
      attributes(30),
      ManagerId('m1'),
      'XX',
      100,
      { speed: 71, stamina: 82, strength: 93 },
    );
    await repository.save(withCeilings);
    expect((await repository.findById(PlayerId('p-physceil')))!.physicalCeilings).toEqual({ speed: 71, stamina: 82, strength: 93 });

    const withoutCeilings = Player.hire(PlayerId('p-physceil-default'), 'Default Test', 19 * 52, attributes(30), ManagerId('m1'));
    await repository.save(withoutCeilings);
    expect((await repository.findById(PlayerId('p-physceil-default')))!.physicalCeilings).toEqual({ speed: 100, stamina: 100, strength: 100 });
  });

  it('round-trips a dormant graduation-carryover bonus, and its absence (null)', async () => {
    const player = Player.hire(PlayerId('p-carryover'), 'Carryover Test', 14 * 52, attributes(30), ManagerId('m1'));
    expect(player.dormantCarryoverBonus).toBeNull(); // default, before any save

    player.setDormantCarryoverBonus({ targetBand: 'u16', bonusPoints: 37.5 });
    await repository.save(player);
    expect((await repository.findById(PlayerId('p-carryover')))!.dormantCarryoverBonus).toEqual({
      targetBand: 'u16',
      bonusPoints: 37.5,
    });

    player.setDormantCarryoverBonus(null);
    await repository.save(player);
    expect((await repository.findById(PlayerId('p-carryover')))!.dormantCarryoverBonus).toBeNull();
  });

  it('updates in place on second save (upsert) and filters findByManager by manager', async () => {
    const m1 = ManagerId('m1');
    const m2 = ManagerId('m2');
    const player = Player.hire(PlayerId('p1'), 'João Silva', 19 * 52, attributes(30), m1);
    await repository.save(player);
    await repository.save(Player.hire(PlayerId('p2'), 'Other Guy', 20 * 52, attributes(40), m2));

    player.applyMatchFatigue(50);
    await repository.save(player); // must update, not violate the PK

    const roster = await repository.findByManager(m1);
    expect(roster).toHaveLength(1);
    expect(roster[0].fatigue).toBe(50);

    expect(await repository.findById(PlayerId('missing'))).toBeNull();
  });
});

describe('DrizzleTrainingScheduleRepository', () => {
  const playerRepository = new DrizzlePlayerRepository(db);
  const scheduleRepository = new DrizzleTrainingScheduleRepository(db);

  it('round-trips a surface-focus entry and an attribute-focus entry for the same player', async () => {
    const player = Player.hire(PlayerId('sched-p1'), 'Schedule Test', 19 * 52, attributes(30), ManagerId('m1'));
    player.pullDomainEvents();
    await playerRepository.save(player);

    await scheduleRepository.save({ playerId: PlayerId('sched-p1'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'clay' } });
    await scheduleRepository.save({ playerId: PlayerId('sched-p1'), effectiveFrom: { season: 1, week: 5 }, focus: { kind: 'attribute', attribute: 'serve' } });

    const entries = (await scheduleRepository.findByPlayer(PlayerId('sched-p1'))).sort((a, b) => a.effectiveFrom.week - b.effectiveFrom.week);
    expect(entries).toEqual([
      { playerId: PlayerId('sched-p1'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'clay' } },
      { playerId: PlayerId('sched-p1'), effectiveFrom: { season: 1, week: 5 }, focus: { kind: 'attribute', attribute: 'serve' } },
    ]);
  });

  it('round-trips an explicit null focus (a real "stop training" order, not an absent row)', async () => {
    const player = Player.hire(PlayerId('sched-p2'), 'Schedule Test 2', 19 * 52, attributes(30), ManagerId('m1'));
    player.pullDomainEvents();
    await playerRepository.save(player);

    await scheduleRepository.save({ playerId: PlayerId('sched-p2'), effectiveFrom: { season: 1, week: 3 }, focus: null });

    const entries = await scheduleRepository.findByPlayer(PlayerId('sched-p2'));
    expect(entries).toEqual([{ playerId: PlayerId('sched-p2'), effectiveFrom: { season: 1, week: 3 }, focus: null }]);
  });

  it('overwrites (does not duplicate) an entry saved twice for the same effective week', async () => {
    const player = Player.hire(PlayerId('sched-p3'), 'Schedule Test 3', 19 * 52, attributes(30), ManagerId('m1'));
    player.pullDomainEvents();
    await playerRepository.save(player);

    await scheduleRepository.save({ playerId: PlayerId('sched-p3'), effectiveFrom: { season: 1, week: 2 }, focus: { kind: 'surface', surface: 'clay' } });
    await scheduleRepository.save({ playerId: PlayerId('sched-p3'), effectiveFrom: { season: 1, week: 2 }, focus: { kind: 'surface', surface: 'grass' } });

    const entries = await scheduleRepository.findByPlayer(PlayerId('sched-p3'));
    expect(entries).toHaveLength(1);
    expect(entries[0].focus).toEqual({ kind: 'surface', surface: 'grass' });
  });

  it('returns an empty array for a player with no schedule entries at all', async () => {
    const player = Player.hire(PlayerId('sched-p4'), 'Schedule Test 4', 19 * 52, attributes(30), ManagerId('m1'));
    player.pullDomainEvents();
    await playerRepository.save(player);

    expect(await scheduleRepository.findByPlayer(PlayerId('sched-p4'))).toEqual([]);
  });
});

describe('DrizzleTournamentRepository', () => {
  const tournamentRepository = new DrizzleTournamentRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);

  async function savePlayers(count: number): Promise<void> {
    for (let i = 1; i <= count; i++) {
      await playerRepository.save(Player.hire(PlayerId(`p${i}`), `Player ${i}`, 20 * 52, attributes(30), ManagerId('m1')));
    }
  }

  it('round-trips a started tournament with a populated bracket and a recorded outcome', async () => {
    await savePlayers(16);

    const original = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t1'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 2, week: 17 },
      drawSize: 16,
    });
    for (let i = 1; i <= 16; i++) {
      original.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
    }
    original.startWithBracket(new BracketGenerator().generate(original.entrants, 16));
    original.recordMatchOutcome(1, 0, {
      winner: PlayerId('p1'),
      loser: PlayerId('p16'),
      setScores: [
        { winnerGames: 6, loserGames: 3 },
        { winnerGames: 7, loserGames: 6 },
      ],
    });
    original.pullDomainEvents();

    await tournamentRepository.save(original);
    const loaded = await tournamentRepository.findById(TournamentId('t1'));

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('t1');
    expect(loaded!.tier).toBe('challenger');
    expect(loaded!.surface).toBe('clay');
    expect(loaded!.weekScheduled).toEqual({ season: 2, week: 17 });
    expect(loaded!.drawSize).toBe(16);
    expect(loaded!.hasStarted).toBe(true);
    // Same set of entrants with the same seeds — not asserting on
    // array order, which the domain never promises is preserved
    // (BracketGenerator seeds off `seed`, never off array position;
    // see DrizzleTournamentRepository.load()'s doc comment on why
    // read order is deterministic but not necessarily insertion order).
    expect([...loaded!.entrants].sort(byPlayerId)).toEqual(persistedEntrants(original.entrants));
    // Deep bracket equality: same rounds, same match order, the one
    // recorded outcome intact with its set scores, the rest null.
    expect(loaded!.getRounds()).toEqual(original.getRounds());
    // Reconstitution must not re-emit TournamentStarted.
    expect(loaded!.pullDomainEvents()).toHaveLength(0);

    // The rehydrated aggregate must still enforce its invariants —
    // recording on the already-decided match throws.
    expect(() =>
      loaded!.recordMatchOutcome(1, 0, { winner: PlayerId('p1'), loser: PlayerId('p16'), setScores: [] }),
    ).toThrow();
  });

  /** Plays a started 16-draw all the way to a decided final, adding each
   * next round through BracketGenerator exactly as the simulator does. */
  function playToCompletion(tournament: Tournament): void {
    const generator = new BracketGenerator();
    for (let roundNumber = 1; roundNumber <= 4; roundNumber++) {
      const round = tournament.getRounds()[roundNumber - 1];
      for (let matchIndex = 0; matchIndex < round.matches.length; matchIndex++) {
        const match = round.matches[matchIndex];
        tournament.recordMatchOutcome(roundNumber, matchIndex, {
          winner: match.entrantA,
          loser: match.entrantB,
          setScores: [{ winnerGames: 6, loserGames: 0 }],
        });
      }
      if (roundNumber < 4) {
        tournament.addRound(
          generator.generateNextRound(tournament.getRounds()[roundNumber - 1], tournament.entrants, 16),
        );
      }
    }
  }

  it('findStartedLive excludes a fully-finished tournament but keeps a live one', async () => {
    await savePlayers(32);

    const finished = Tournament.open({ name: 'Finished', id: TournamentId('t-finished'), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize: 16 });
    for (let i = 1; i <= 16; i++) finished.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
    finished.startWithBracket(new BracketGenerator().generate(finished.entrants, 16));
    playToCompletion(finished);
    finished.pullDomainEvents();
    await tournamentRepository.save(finished);
    expect(finished.isMainDrawFinished()).toBe(true);

    const live = Tournament.open({ name: 'Live', id: TournamentId('t-live'), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize: 16 });
    for (let i = 17; i <= 32; i++) live.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i - 16 });
    live.startWithBracket(new BracketGenerator().generate(live.entrants, 16));
    live.pullDomainEvents();
    await tournamentRepository.save(live);

    const notStarted = Tournament.open({ name: 'Open', id: TournamentId('t-open'), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize: 16 });
    await tournamentRepository.save(notStarted);

    const liveIds = (await tournamentRepository.findStartedLive()).map((t) => t.id).sort();

    expect(liveIds).toEqual(['t-live']);
    // The unbounded accessor still returns everything started, for the
    // per-request / diagnostic callers that use it.
    expect((await tournamentRepository.findStarted()).map((t) => t.id).sort()).toEqual(['t-finished', 't-live']);
  });

  it('findStartedWithinWindow returns only started events inside the rolling window, reconstituted', async () => {
    await savePlayers(64);

    const makeConcluded = (
      id: string,
      weekScheduled: { season: number; week: number },
      firstPlayer: number,
    ): Tournament => {
      const t = Tournament.open({
        name: id,
        id: TournamentId(id),
        tier: 'major',
        surface: 'hard',
        weekScheduled,
        drawSize: 16,
      });
      for (let i = firstPlayer; i < firstPlayer + 16; i++) {
        t.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i - firstPlayer + 1 });
      }
      t.startWithBracket(new BracketGenerator().generate(t.entrants, 16));
      playToCompletion(t);
      t.pullDomainEvents();
      return t;
    };

    // currentWeek absolute = 2*52 + 20 = 124. The window is [124-52, 124] = [72, 124].
    const currentWeek = { season: 2, week: 20 };
    const inside = makeConcluded('t-inside', { season: 2, week: 10 }, 1); // absolute 114, age 10
    const edge = makeConcluded('t-edge', { season: 1, week: 20 }, 17); // absolute 72, age 52 exactly (inclusive)
    const tooOld = makeConcluded('t-too-old', { season: 1, week: 19 }, 33); // absolute 71, age 53
    const notStarted = Tournament.open({
      name: 'Not started',
      id: TournamentId('t-not-started'),
      tier: 'major',
      surface: 'hard',
      weekScheduled: { season: 2, week: 10 },
      drawSize: 16,
    });
    await tournamentRepository.save(inside);
    await tournamentRepository.save(edge);
    await tournamentRepository.save(tooOld);
    await tournamentRepository.save(notStarted);

    const found = await tournamentRepository.findStartedWithinWindow(currentWeek, RANKING_WINDOW_WEEKS);

    // Inclusive both ends, started only, out-of-window dropped — the SQL
    // prefilter never loaded `t-too-old` or `t-not-started`.
    expect(found.map((t) => t.id).sort()).toEqual(['t-edge', 't-inside']);

    // The rows that DID pass the prefilter still reconstitute fully: a
    // decided final survives, and rehydration emits no lifecycle events.
    const reconstituted = found.find((t) => t.id === 't-inside')!;
    expect(reconstituted.hasStarted).toBe(true);
    expect(reconstituted.isMainDrawFinished()).toBe(true);
    expect(reconstituted.getRounds()).toEqual(inside.getRounds());
    expect(reconstituted.pullDomainEvents()).toHaveLength(0);

    // findStarted() itself is unchanged (still the unbounded read, and
    // still started-only — the never-started shell is not returned).
    expect((await tournamentRepository.findStarted()).map((t) => t.id).sort()).toEqual([
      't-edge',
      't-inside',
      't-too-old',
    ]);
  });

  it('deleteAbandonedTournament removes an empty shell and a filler-only draw, but never one with a manager-owned entrant', async () => {
    await savePlayers(1);

    const shell = Tournament.open({ name: 'Shell', id: TournamentId('t-shell'), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize: 16 });
    await tournamentRepository.save(shell);
    expect(await tournamentRepository.deleteAbandonedTournament(TournamentId('t-shell'))).toBe(true);
    expect(await tournamentRepository.findById(TournamentId('t-shell'))).toBeNull();

    // A never-started draw whose only entrants are fillers/free agents
    // (manager_id null) is expirable: deleting it releases them from the
    // unfinished-commitment lock they'd otherwise sit in forever.
    await playerRepository.save(Player.generateFillOnly(PlayerId('f1'), 'Filler One', 25 * 52, 'prime', attributes(30), 'BR'));
    await playerRepository.save(Player.generateFillOnly(PlayerId('f2'), 'Filler Two', 25 * 52, 'prime', attributes(30), 'BR'));
    const fillerOnly = Tournament.open({ name: 'Filler Only', id: TournamentId('t-filler-only'), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize: 16 });
    fillerOnly.registerEntrant({ playerId: PlayerId('f1'), seed: null });
    fillerOnly.registerEntrant({ playerId: PlayerId('f2'), seed: null });
    await tournamentRepository.save(fillerOnly);
    expect(await tournamentRepository.deleteAbandonedTournament(TournamentId('t-filler-only'))).toBe(true);
    expect(await tournamentRepository.findById(TournamentId('t-filler-only'))).toBeNull();
    // The fillers themselves survive the cascade — they're free agents
    // again, not deleted along with the draw.
    expect(await playerRepository.findById(PlayerId('f1'))).not.toBeNull();

    // A single manager-owned entrant blocks the delete entirely.
    const entered = Tournament.open({ name: 'Entered', id: TournamentId('t-entered'), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize: 16 });
    entered.registerEntrant({ playerId: PlayerId('p1'), seed: null });
    await tournamentRepository.save(entered);
    expect(await tournamentRepository.deleteAbandonedTournament(TournamentId('t-entered'))).toBe(false);
    expect(await tournamentRepository.findById(TournamentId('t-entered'))).not.toBeNull();
  });

  it('round-trips a tournament with a qualifying draw, and a promoted qualifier (the FULL model)', async () => {
    await savePlayers(22);

    const original = Tournament.open({
      name: 'Test Qualifying Tournament',
      id: TournamentId('tq1'),
      tier: 'tour',
      surface: 'hard',
      weekScheduled: { season: 2, week: 18 },
      drawSize: 16,
      qualifyingDrawSize: 8,
      qualifierSlots: 2,
    });

    // 8 players contest the 2 reserved slots; 14 take direct-acceptance
    // places (mainDrawCapacity = drawSize - qualifierSlots = 14).
    for (let i = 1; i <= 8; i++) {
      original.registerEntrant({ playerId: PlayerId(`p${i}`), seed: null, draw: 'qualifying', entryType: 'Q' });
    }
    for (let i = 9; i <= 22; i++) {
      original.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i - 8 });
    }

    original.startQualifyingWithBracket(new BracketGenerator().generate(original.qualifyingEntrants, 8));
    original.recordMatchOutcome(
      1,
      0,
      { winner: PlayerId('p1'), loser: PlayerId('p8'), setScores: [{ winnerGames: 6, loserGames: 3 }] },
      'qualifying',
    );
    original.pullDomainEvents();

    await tournamentRepository.save(original);
    let loaded = await tournamentRepository.findById(TournamentId('tq1'));

    expect(loaded).not.toBeNull();
    expect(loaded!.hasQualifying).toBe(true);
    expect(loaded!.qualifyingDrawSize).toBe(8);
    expect(loaded!.qualifierSlots).toBe(2);
    expect(loaded!.hasStarted).toBe(true); // qualifying seeded
    expect(loaded!.hasMainDraw).toBe(false); // deferred main-draw seeding
    expect([...loaded!.entrants].sort(byPlayerId)).toEqual(persistedEntrants(original.entrants));
    expect(loaded!.getQualifyingRounds()).toEqual(original.getQualifyingRounds());
    expect(loaded!.getRounds()).toEqual([]);
    expect(loaded!.pullDomainEvents()).toHaveLength(0);

    // Promote a qualifier and seed the main draw — the transition the
    // worker's PromoteQualifiersUseCase drives. The promoted entrant
    // keeps entryType 'Q' while moving to draw 'main'.
    original.promoteQualifier(PlayerId('p1'));
    original.startWithBracket(new BracketGenerator().generate(original.mainEntrants, 16));
    original.pullDomainEvents();
    await tournamentRepository.save(original);
    loaded = await tournamentRepository.findById(TournamentId('tq1'));

    expect(loaded!.hasMainDraw).toBe(true);
    expect([...loaded!.entrants].sort(byPlayerId)).toEqual(persistedEntrants(original.entrants));
    const promoted = loaded!.entrants.find((e) => e.playerId === PlayerId('p1'));
    expect(promoted).toBeDefined();
    expect(drawOf(promoted!)).toBe('main');
    expect(entryTypeOf(promoted!)).toBe('Q');
    expect(loaded!.getRounds()).toEqual(original.getRounds());
  });

  it('round-trips a tournament with a doubles draw: entrants, formed pairs, and the pair-keyed bracket (P7b)', async () => {
    await savePlayers(8);

    const original = Tournament.open({
      name: 'Test Doubles Tournament',
      id: TournamentId('td1'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 2, week: 19 },
      drawSize: 16,
      doublesDrawSize: 4,
    });
    for (let i = 1; i <= 8; i++) {
      original.registerDoublesEntrant(PlayerId(`p${i}`));
    }

    const pairs = [
      { pairId: PairId('td1-d0'), playerA: PlayerId('p1'), playerB: PlayerId('p2'), chemistry: 0 },
      { pairId: PairId('td1-d1'), playerA: PlayerId('p3'), playerB: PlayerId('p4'), chemistry: 0 },
      { pairId: PairId('td1-d2'), playerA: PlayerId('p5'), playerB: PlayerId('p6'), chemistry: 0 },
      { pairId: PairId('td1-d3'), playerA: PlayerId('p7'), playerB: PlayerId('p8'), chemistry: 0 },
    ];
    const bracket = new BracketGenerator().generate(pairs.map((p) => ({ playerId: p.pairId, seed: null })), 4);
    original.startDoublesWithBracket(pairs, bracket);
    original.recordDoublesMatchOutcome(1, 0, {
      winner: PairId('td1-d0'),
      loser: PairId('td1-d3'),
      setScores: [{ winnerGames: 6, loserGames: 3 }],
    });
    original.pullDomainEvents();

    await tournamentRepository.save(original);
    const loaded = await tournamentRepository.findById(TournamentId('td1'));

    expect(loaded).not.toBeNull();
    expect(loaded!.doublesDrawSize).toBe(4);
    expect(loaded!.hasDoubles).toBe(true);
    expect(loaded!.hasStarted).toBe(true); // doubles draw seeded
    expect([...loaded!.doublesEntrants].sort()).toEqual([...original.doublesEntrants].sort());
    expect(loaded!.doublesPairs).toEqual(pairs);
    expect(loaded!.getDoublesRounds()).toEqual(original.getDoublesRounds());
    expect(loaded!.doublesPlayersFor(PairId('td1-d0'))!.playerB).toBe(PlayerId('p2'));
    expect(loaded!.pullDomainEvents()).toHaveLength(0);
  });

  it('round-trips a junior tournament with its ageBand, and a senior tournament with a null ageBand', async () => {
    const junior = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-junior'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'clay',
      weekScheduled: { season: 1, week: 3 },
      drawSize: 32,
    });
    await tournamentRepository.save(junior);
    const loadedJunior = await tournamentRepository.findById(TournamentId('t-junior'));
    expect(loadedJunior!.tier).toBe('j100');
    expect(loadedJunior!.ageBand).toBe('u14');

    const senior = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-senior'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 3 },
      drawSize: 32,
    });
    await tournamentRepository.save(senior);
    const loadedSenior = await tournamentRepository.findById(TournamentId('t-senior'));
    expect(loadedSenior!.tier).toBe('challenger');
    expect(loadedSenior!.ageBand).toBeNull();
  });

  it("findByPlayerAndWeek returns only this player's tournaments scheduled exactly that week", async () => {
    await savePlayers(3);

    const sameWeek1 = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-fpw-1'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'clay',
      weekScheduled: { season: 2, week: 8 },
      drawSize: 16,
    });
    sameWeek1.registerEntrant({ playerId: PlayerId('p1'), seed: null });
    await tournamentRepository.save(sameWeek1);

    const sameWeek2 = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-fpw-2'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 2, week: 8 },
      drawSize: 16,
    });
    sameWeek2.registerEntrant({ playerId: PlayerId('p1'), seed: null });
    await tournamentRepository.save(sameWeek2);

    // Different week — must be excluded.
    const differentWeek = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-fpw-3'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'clay',
      weekScheduled: { season: 2, week: 9 },
      drawSize: 16,
    });
    differentWeek.registerEntrant({ playerId: PlayerId('p1'), seed: null });
    await tournamentRepository.save(differentWeek);

    // Same week, but a different player — must be excluded.
    const otherPlayerSameWeek = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-fpw-4'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'clay',
      weekScheduled: { season: 2, week: 8 },
      drawSize: 16,
    });
    otherPlayerSameWeek.registerEntrant({ playerId: PlayerId('p2'), seed: null });
    await tournamentRepository.save(otherPlayerSameWeek);

    const results = await tournamentRepository.findByPlayerAndWeek(PlayerId('p1'), { season: 2, week: 8 });
    expect(results.map((t) => t.id).sort()).toEqual(['t-fpw-1', 't-fpw-2']);
  });

  it('countManagerEntrants counts only manager-owned entrants, in one grouped read', async () => {
    await playerRepository.save(Player.hire(PlayerId('cme-p1'), 'Owned One', 20 * 52, attributes(30), ManagerId('m1')));
    await playerRepository.save(Player.hire(PlayerId('cme-p2'), 'Owned Two', 20 * 52, attributes(30), ManagerId('m1')));
    await playerRepository.save(Player.generateFillOnly(PlayerId('cme-f1'), 'Free Agent', 20 * 52, 'prime', attributes(30), 'BR'));

    const mixed = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-cme-1'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 2, week: 8 },
      drawSize: 16,
    });
    mixed.registerEntrant({ playerId: PlayerId('cme-p1'), seed: null });
    mixed.registerEntrant({ playerId: PlayerId('cme-p2'), seed: null });
    mixed.registerEntrant({ playerId: PlayerId('cme-f1'), seed: null });
    await tournamentRepository.save(mixed);

    // Only a free agent entered this one — it must be absent from the map (0).
    const fillerOnly = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-cme-2'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 2, week: 8 },
      drawSize: 16,
    });
    fillerOnly.registerEntrant({ playerId: PlayerId('cme-f1'), seed: null });
    await tournamentRepository.save(fillerOnly);

    const counts = await tournamentRepository.countManagerEntrants!([TournamentId('t-cme-1'), TournamentId('t-cme-2')]);
    expect(counts.get('t-cme-1')).toBe(2);
    expect(counts.get('t-cme-2')).toBeUndefined();
    expect(await tournamentRepository.countManagerEntrants!([])).toEqual(new Map());
  });

  it('round-trips an unstarted tournament and lists it via findOpenForRegistration', async () => {
    await savePlayers(10);

    const original = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t2'),
      tier: 'futures',
      surface: 'hard',
      weekScheduled: { season: 1, week: 3 },
      drawSize: 16,
    });
    for (let i = 1; i <= 9; i++) {
      original.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
    }
    original.registerEntrant({ playerId: PlayerId('p10'), seed: null }); // null seed must round-trip too

    await tournamentRepository.save(original);

    const open = await tournamentRepository.findOpenForRegistration();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe('t2');
    expect(open[0].hasStarted).toBe(false);
    // Same set of entrants, not asserting on array order — see the
    // other round-trip test's comment on why.
    expect([...open[0].entrants].sort(byPlayerId)).toEqual(persistedEntrants(original.entrants));
    expect(open[0].getRounds()).toHaveLength(0);

    // Saving again after it starts flips it out of the open list.
    original.startWithBracket(new BracketGenerator().generate(original.entrants, 16));
    await tournamentRepository.save(original);
    expect(await tournamentRepository.findOpenForRegistration()).toHaveLength(0);
  });

  it('refuses a stale whole-aggregate write instead of silently dropping a concurrent registration', async () => {
    await savePlayers(4);
    const original = Tournament.open({
      name: 'Concurrency Cup',
      id: TournamentId('tc1'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    await tournamentRepository.save(original);

    // Two writers load the SAME version independently (the real race:
    // two managers registering for the same tournament at once)...
    const writerA = (await tournamentRepository.findById(TournamentId('tc1')))!;
    const writerB = (await tournamentRepository.findById(TournamentId('tc1')))!;
    writerA.registerEntrant({ playerId: PlayerId('p1'), seed: 1 });
    writerB.registerEntrant({ playerId: PlayerId('p2'), seed: 2 });

    // ...the first to save lands and is persisted...
    await tournamentRepository.save(writerA);
    // ...the second is refused loudly (mapped to a retryable 409 by the
    // HTTP layer) rather than clobbering writer A's entrant — the whole
    // point, since the previous delete+reinsert was last-writer-wins.
    await expect(tournamentRepository.save(writerB)).rejects.toThrow(ConcurrentModificationError);

    const reloaded = await tournamentRepository.findById(TournamentId('tc1'));
    expect(reloaded!.entrants.map((e) => e.playerId)).toEqual([PlayerId('p1')]);
  });

  it('allows the SAME instance to be saved repeatedly (the version is written back), so multi-save use cases still work', async () => {
    await savePlayers(2);
    const original = Tournament.open({
      name: 'Multi Save Open',
      id: TournamentId('tc2'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    await tournamentRepository.save(original); // v1
    original.registerEntrant({ playerId: PlayerId('p1'), seed: 1 });
    await tournamentRepository.save(original); // v2
    original.registerEntrant({ playerId: PlayerId('p2'), seed: 2 });
    await tournamentRepository.save(original); // v3

    const reloaded = await tournamentRepository.findById(TournamentId('tc2'));
    expect([...reloaded!.entrants.map((e) => e.playerId)].sort()).toEqual([PlayerId('p1'), PlayerId('p2')]);
  });
});

describe('DrizzleRankingLedgerRepository', () => {
  const ledgerRepository = new DrizzleRankingLedgerRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const tournamentRepository = new DrizzleTournamentRepository(db);

  it("round-trips a junior entry's ageBand and a senior entry's null ageBand", async () => {
    await playerRepository.save(Player.hire(PlayerId('p1'), 'Junior Player', 14 * 52, attributes(30), ManagerId('m1')));

    const juniorTournament = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-junior-ledger'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'clay',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    await tournamentRepository.save(juniorTournament);

    const seniorTournament = Tournament.open({ name: 'Test Tournament',
      id: TournamentId('t-senior-ledger'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    await tournamentRepository.save(seniorTournament);

    await ledgerRepository.append({
      playerId: PlayerId('p1'),
      tournamentId: TournamentId('t-junior-ledger'),
      tier: 'j100',
      ageBand: 'u14',
      points: 18,
      weekEarned: { season: 1, week: 1 },
    });
    await ledgerRepository.append({
      playerId: PlayerId('p1'),
      tournamentId: TournamentId('t-senior-ledger'),
      tier: 'challenger',
      ageBand: null,
      points: 11,
      weekEarned: { season: 1, week: 1 },
    });

    const entries = await ledgerRepository.findByPlayer(PlayerId('p1'));
    expect(entries).toHaveLength(2);

    const juniorEntry = entries.find((e) => e.tournamentId === TournamentId('t-junior-ledger'));
    expect(juniorEntry?.ageBand).toBe('u14');

    const seniorEntry = entries.find((e) => e.tournamentId === TournamentId('t-senior-ledger'));
    expect(seniorEntry?.ageBand).toBeNull();
  });

  it("round-trips the mandatory-skip `obligatory` flag, and reads an entry written without it as false", async () => {
    await playerRepository.save(Player.hire(PlayerId('p-obl'), 'Obligated Player', 24 * 52, attributes(30), ManagerId('m1')));
    const major = Tournament.open({
      name: 'Obligatory Test Major',
      id: TournamentId('t-major-obl'),
      tier: 'major',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 128,
    });
    const challenger = Tournament.open({
      name: 'Ordinary Test Challenger',
      id: TournamentId('t-ch-obl'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    await tournamentRepository.save(major);
    await tournamentRepository.save(challenger);

    // A mandatory-SKIP zero (what ApplyObligatoryTournamentZerosUseCase
    // writes) …
    await ledgerRepository.append({
      playerId: PlayerId('p-obl'),
      tournamentId: TournamentId('t-major-obl'),
      tier: 'major',
      ageBand: null,
      points: 0,
      weekEarned: { season: 1, week: 1 },
      obligatory: true,
    });
    // … and an ordinary result, written with the field absent exactly
    // as every pre-existing call site does.
    await ledgerRepository.append({
      playerId: PlayerId('p-obl'),
      tournamentId: TournamentId('t-ch-obl'),
      tier: 'challenger',
      ageBand: null,
      points: 45,
      weekEarned: { season: 1, week: 1 },
    });

    const entries = await ledgerRepository.findByPlayer(PlayerId('p-obl'));
    expect(entries.find((e) => e.tournamentId === TournamentId('t-major-obl'))?.obligatory).toBe(true);
    expect(entries.find((e) => e.tournamentId === TournamentId('t-ch-obl'))?.obligatory).toBe(false);
  });
});

describe('DrizzlePeakRankingRepository', () => {
  const peakRankings = new DrizzlePeakRankingRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);

  it('upserts in place — the row count for one (player, band) stays at exactly one real row no matter how many times it is updated, per docs/data-archival-principles.md', async () => {
    await playerRepository.save(Player.hire(PlayerId('p-peak-1'), 'Peak Player', 20 * 52, attributes(30), ManagerId('m1')));

    // 10 successive "fresh ranking computation" writes for the SAME
    // (player, band) — simulating what SimulateMatchUseCase does on
    // every ranking-ledger write point over a long career.
    for (let i = 1; i <= 10; i++) {
      await peakRankings.upsert({
        playerId: PlayerId('p-peak-1'),
        band: 'senior',
        peakPoints: i * 10,
        peakAsOfWeek: { season: 1, week: i },
      });
    }

    // The table's REAL row count for this player, read directly via
    // SQL (not through the repository's own findOne, which could mask
    // a duplicate-row bug by just returning the first match) — proves
    // this was 10 real UPDATEs, not 10 accumulating INSERTs.
    const rawRows = await db.select().from(schema.peakRankings).where(eq(schema.peakRankings.playerId, 'p-peak-1'));
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].peakPoints).toBe(100); // the last (and highest) value written

    const found = await peakRankings.findOne(PlayerId('p-peak-1'), 'senior');
    expect(found?.peakPoints).toBe(100);
  });

  it('keeps a separate row per band for the same player — row count bounded by player × scope, not by update count', async () => {
    await playerRepository.save(Player.hire(PlayerId('p-peak-2'), 'Multi Band Player', 12 * 52, attributes(30), ManagerId('m1')));

    for (const band of ['senior', 'u14', 'u16'] as const) {
      for (let i = 1; i <= 3; i++) {
        await peakRankings.upsert({
          playerId: PlayerId('p-peak-2'),
          band,
          peakPoints: i * 5,
          peakAsOfWeek: { season: 1, week: i },
        });
      }
    }

    const rawRows = await db.select().from(schema.peakRankings).where(eq(schema.peakRankings.playerId, 'p-peak-2'));
    expect(rawRows).toHaveLength(3); // exactly one per band, not 9 (3 bands x 3 updates each)

    const all = await peakRankings.findAllForPlayer(PlayerId('p-peak-2'));
    expect(all.map((p) => p.band).sort()).toEqual(['senior', 'u14', 'u16']);
  });

  it('returns null for a player/band with no recorded peak yet', async () => {
    await playerRepository.save(Player.hire(PlayerId('p-peak-3'), 'No Peak Yet', 20 * 52, attributes(30), ManagerId('m1')));
    const found = await peakRankings.findOne(PlayerId('p-peak-3'), 'senior');
    expect(found).toBeNull();
  });
});

describe('DrizzleTitleRepository', () => {
  const titleRepository = new DrizzleTitleRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const tournamentRepository = new DrizzleTournamentRepository(db);

  it('round-trips a title record, referencing the tournament by id rather than copying its data', async () => {
    await playerRepository.save(Player.hire(PlayerId('p-title-1'), 'Champion', 20 * 52, attributes(30), ManagerId('m1')));
    const tournament = Tournament.open({
      name: 'Test Championship',
      id: TournamentId('t-title-1'),
      tier: 'major',
      surface: 'grass',
      weekScheduled: { season: 1, week: 3 },
      drawSize: 16,
    });
    await tournamentRepository.save(tournament);

    await titleRepository.append({
      tournamentId: TournamentId('t-title-1'),
      playerId: PlayerId('p-title-1'),
      tier: 'major',
      ageBand: null,
      weekEarned: { season: 1, week: 3 },
    });

    const titles = await titleRepository.findByPlayer(PlayerId('p-title-1'));
    expect(titles).toHaveLength(1);
    expect(titles[0]).toEqual({
      tournamentId: TournamentId('t-title-1'),
      playerId: PlayerId('p-title-1'),
      tier: 'major',
      ageBand: null,
      weekEarned: { season: 1, week: 3 },
    });
  });

  it('refuses a second title for the same tournament — a real DB constraint (tournament_id primary key), not just application convention', async () => {
    await playerRepository.save(Player.hire(PlayerId('p-title-2'), 'Champion', 20 * 52, attributes(30), ManagerId('m1')));
    await playerRepository.save(Player.hire(PlayerId('p-title-3'), 'Someone Else', 20 * 52, attributes(30), ManagerId('m1')));
    const tournament = Tournament.open({
      name: 'Test Championship',
      id: TournamentId('t-title-2'),
      tier: 'tour',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    await tournamentRepository.save(tournament);

    await titleRepository.append({
      tournamentId: TournamentId('t-title-2'),
      playerId: PlayerId('p-title-2'),
      tier: 'tour',
      ageBand: null,
      weekEarned: { season: 1, week: 1 },
    });

    await expect(
      titleRepository.append({
        tournamentId: TournamentId('t-title-2'),
        playerId: PlayerId('p-title-3'),
        tier: 'tour',
        ageBand: null,
        weekEarned: { season: 1, week: 1 },
      }),
    ).rejects.toThrow();
  });

  it('returns an empty list for a player with no titles yet', async () => {
    await playerRepository.save(Player.hire(PlayerId('p-title-4'), 'No Titles Yet', 20 * 52, attributes(30), ManagerId('m1')));
    const titles = await titleRepository.findByPlayer(PlayerId('p-title-4'));
    expect(titles).toEqual([]);
  });

  it('countByPlayers returns per-player counts and omits players with no titles', async () => {
    await playerRepository.save(Player.hire(PlayerId('p-count-1'), 'Two Titles', 20 * 52, attributes(30), ManagerId('m1')));
    await playerRepository.save(Player.hire(PlayerId('p-count-2'), 'One Title', 20 * 52, attributes(30), ManagerId('m1')));
    await playerRepository.save(Player.hire(PlayerId('p-count-3'), 'None Yet', 20 * 52, attributes(30), ManagerId('m1')));
    for (const id of ['t-count-1', 't-count-2', 't-count-3']) {
      await tournamentRepository.save(
        Tournament.open({ name: 'Count Cup', id: TournamentId(id), tier: 'tour', surface: 'hard', weekScheduled: { season: 1, week: 1 }, drawSize: 16 }),
      );
    }
    await titleRepository.append({ tournamentId: TournamentId('t-count-1'), playerId: PlayerId('p-count-1'), tier: 'tour', ageBand: null, weekEarned: { season: 1, week: 1 } });
    await titleRepository.append({ tournamentId: TournamentId('t-count-2'), playerId: PlayerId('p-count-1'), tier: 'tour', ageBand: null, weekEarned: { season: 1, week: 1 } });
    await titleRepository.append({ tournamentId: TournamentId('t-count-3'), playerId: PlayerId('p-count-2'), tier: 'tour', ageBand: null, weekEarned: { season: 1, week: 1 } });

    const counts = await titleRepository.countByPlayers([
      PlayerId('p-count-1'),
      PlayerId('p-count-2'),
      PlayerId('p-count-3'),
    ]);
    expect(counts.get(PlayerId('p-count-1'))).toBe(2);
    expect(counts.get(PlayerId('p-count-2'))).toBe(1);
    expect(counts.has(PlayerId('p-count-3'))).toBe(false);
  });
});

describe('DrizzlePlayerMatchesQuery.liveTournamentByPlayer', () => {
  const query = new DrizzlePlayerMatchesQuery(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const agingPolicy = new StandardAgingPolicy();

  function saveFree(id: string, name: string) {
    return playerRepository.save(
      Player.generateFillOnly(PlayerId(id), name, 20 * 52, agingPolicy.stageForAge(20 * 52), attributes(40), 'ES', 70, {
        speed: 70,
        stamina: 70,
        strength: 70,
      }),
    );
  }

  it('returns the live tournament for a free agent still alive in a draw, and omits eliminated/history-only players', async () => {
    await saveFree('fa-alive', 'Alive Free Agent');
    await saveFree('fa-opp', 'Live Opponent');
    await saveFree('fa-out', 'Eliminated Free Agent');
    await saveFree('fa-other', 'Other Player');

    await db.insert(schema.tournaments).values([
      { id: 'live-t1', name: 'Live Open', tier: 'tour', surface: 'hard', seasonScheduled: 1, weekScheduled: 2, drawSize: 16 },
      { id: 'live-t2', name: 'Finished Open', tier: 'tour', surface: 'hard', seasonScheduled: 1, weekScheduled: 1, drawSize: 16 },
    ]);
    await db.insert(schema.tournamentMatches).values([
      // Still to play -> alive in live-t1.
      { tournamentId: 'live-t1', draw: 'main', roundNumber: 1, matchIndex: 0, entrantA: PlayerId('fa-alive'), entrantB: PlayerId('fa-opp'), winnerId: null, loserId: null, setScores: null },
      // Decided loss -> eliminated, no live tournament.
      {
        tournamentId: 'live-t2',
        draw: 'main',
        roundNumber: 1,
        matchIndex: 0,
        entrantA: PlayerId('fa-out'),
        entrantB: PlayerId('fa-other'),
        winnerId: PlayerId('fa-other'),
        loserId: PlayerId('fa-out'),
        setScores: [{ winnerGames: 6, loserGames: 2 }],
      },
    ]);

    const live = await query.liveTournamentByPlayer([
      PlayerId('fa-alive'),
      PlayerId('fa-out'),
      PlayerId('fa-never-entered'),
    ]);
    expect(live.get(PlayerId('fa-alive'))).toEqual({ id: 'live-t1', name: 'Live Open' });
    expect(live.has(PlayerId('fa-out'))).toBe(false);
    expect(live.has(PlayerId('fa-never-entered'))).toBe(false);
    expect(await query.liveTournamentByPlayer([])).toEqual(new Map());
  });

  it('flags a player whose match is decided but still inside its reveal window', async () => {
    // The real false negative: `winner_id IS NULL` missed a simulated match
    // that had not aired yet, so a free agent shown as "next up" on their
    // profile had no "Competing" badge in the Scouting pool.
    await saveFree('fa-revealing', 'Revealing Free Agent');
    await saveFree('fa-beaten', 'Already Beaten');
    await db.insert(schema.tournaments).values({
      id: 'live-reveal',
      name: 'Reveal Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 2,
      drawSize: 16,
    });
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'live-reveal',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('fa-revealing'),
      entrantB: PlayerId('fa-beaten'),
      winnerId: PlayerId('fa-revealing'),
      loserId: PlayerId('fa-beaten'),
      setScores: [{ winnerGames: 6, loserGames: 4 }],
      scheduledStartAt: new Date(Date.now() + 60_000),
      revealSeconds: 900,
    });

    const live = await query.liveTournamentByPlayer([PlayerId('fa-revealing'), PlayerId('fa-beaten')]);
    // Both players are still mid-event until the match airs.
    expect(live.get(PlayerId('fa-revealing'))).toEqual({ id: 'live-reveal', name: 'Reveal Open' });
    expect(live.get(PlayerId('fa-beaten'))).toEqual({ id: 'live-reveal', name: 'Reveal Open' });
  });

  it('does not flag a player whose decided match has already aired', async () => {
    await saveFree('fa-airdone', 'Aired Winner');
    await saveFree('fa-airlost', 'Aired Loser');
    await db.insert(schema.tournaments).values({
      id: 'live-aired',
      name: 'Aired Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 2,
      drawSize: 16,
    });
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'live-aired',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('fa-airdone'),
      entrantB: PlayerId('fa-airlost'),
      winnerId: PlayerId('fa-airdone'),
      loserId: PlayerId('fa-airlost'),
      setScores: [{ winnerGames: 6, loserGames: 0 }],
      scheduledStartAt: new Date(Date.now() - 60 * 60_000),
      revealSeconds: 900,
    });

    const live = await query.liveTournamentByPlayer([PlayerId('fa-airdone'), PlayerId('fa-airlost')]);
    expect(live.has(PlayerId('fa-airdone'))).toBe(false);
    expect(live.has(PlayerId('fa-airlost'))).toBe(false);
  });

  it('flags a player only in a doubles draw with a pending match (the pair-keyed gap)', async () => {
    await saveFree('fa-doubles-a', 'Doubles A');
    await saveFree('fa-doubles-b', 'Doubles B');
    await saveFree('fa-doubles-out-a', 'Out A');
    await saveFree('fa-doubles-out-b', 'Out B');
    await db.insert(schema.tournaments).values([
      { id: 'live-doubles', name: 'Doubles Live Open', tier: 'tour', surface: 'hard', seasonScheduled: 1, weekScheduled: 2, drawSize: 16, doublesDrawSize: 8 },
      { id: 'live-doubles-out', name: 'Doubles Done Open', tier: 'tour', surface: 'hard', seasonScheduled: 1, weekScheduled: 1, drawSize: 16, doublesDrawSize: 8 },
    ]);
    await db.insert(schema.tournamentDoublesPairs).values([
      { tournamentId: 'live-doubles', pairId: 'live-pair', playerA: PlayerId('fa-doubles-a'), playerB: PlayerId('fa-doubles-b') },
      { tournamentId: 'live-doubles-out', pairId: 'out-pair', playerA: PlayerId('fa-doubles-out-a'), playerB: PlayerId('fa-doubles-out-b') },
    ]);
    await db.insert(schema.tournamentDoublesMatches).values([
      // Pending -> alive.
      { tournamentId: 'live-doubles', draw: 'main', roundNumber: 1, matchIndex: 0, entrantA: 'live-pair', entrantB: 'other-pair', winnerId: null, loserId: null, setScores: null },
      // Decided and long aired -> not competing.
      {
        tournamentId: 'live-doubles-out',
        draw: 'main',
        roundNumber: 1,
        matchIndex: 0,
        entrantA: 'out-pair',
        entrantB: 'opponent-pair',
        winnerId: 'opponent-pair',
        loserId: 'out-pair',
        setScores: [{ winnerGames: 6, loserGames: 3 }],
        scheduledStartAt: new Date(Date.now() - 60 * 60_000),
        revealSeconds: 900,
      },
    ]);

    const live = await query.liveTournamentByPlayer([
      PlayerId('fa-doubles-a'),
      PlayerId('fa-doubles-b'),
      PlayerId('fa-doubles-out-a'),
      PlayerId('fa-doubles-out-b'),
    ]);
    expect(live.get(PlayerId('fa-doubles-a'))).toEqual({ id: 'live-doubles', name: 'Doubles Live Open' });
    expect(live.get(PlayerId('fa-doubles-b'))).toEqual({ id: 'live-doubles', name: 'Doubles Live Open' });
    expect(live.has(PlayerId('fa-doubles-out-a'))).toBe(false);
    expect(live.has(PlayerId('fa-doubles-out-b'))).toBe(false);
  });
});

describe('DrizzlePlayerMatchesQuery.unfinishedCommitmentByPlayer', () => {
  const query = new DrizzlePlayerMatchesQuery(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const agingPolicy = new StandardAgingPolicy();

  function saveFree(id: string, name: string) {
    return playerRepository.save(
      Player.generateFillOnly(PlayerId(id), name, 20 * 52, agingPolicy.stageForAge(20 * 52), attributes(40), 'ES', 70, {
        speed: 70,
        stamina: 70,
        strength: 70,
      }),
    );
  }

  it('flags a player entered in a tournament that has not even started (the case a match-based read misses)', async () => {
    // The signing rule is tournament-level: an entry in an unstarted draw
    // is an unfinished commitment even though no match row exists yet —
    // exactly why this read (not liveTournamentByPlayer) drives the
    // disabled Sign button.
    await saveFree('fa-entered', 'Entered Free Agent');
    await db.insert(schema.tournaments).values({
      id: 'commit-notstarted',
      name: 'Not Started Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 3,
      drawSize: 16,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'commit-notstarted',
      playerId: PlayerId('fa-entered'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });

    const blocked = await query.unfinishedCommitmentByPlayer([PlayerId('fa-entered'), PlayerId('fa-unknown')]);
    expect(blocked.get(PlayerId('fa-entered'))).toEqual({ id: 'commit-notstarted', name: 'Not Started Open' });
    expect(blocked.has(PlayerId('fa-unknown'))).toBe(false);
    expect(await query.unfinishedCommitmentByPlayer([])).toEqual(new Map());
  });

  it('clears the flag once every main-draw match is decided', async () => {
    await saveFree('fa-finished', 'Finished Free Agent');
    await saveFree('fa-finished-opp', 'Finished Opponent');
    await db.insert(schema.tournaments).values({
      id: 'commit-finished',
      name: 'Finished Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 1,
      drawSize: 16,
      hasStarted: true,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'commit-finished',
      playerId: PlayerId('fa-finished'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'commit-finished',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('fa-finished'),
      entrantB: PlayerId('fa-finished-opp'),
      winnerId: PlayerId('fa-finished'),
      loserId: PlayerId('fa-finished-opp'),
      setScores: [{ winnerGames: 6, loserGames: 2 }],
    });

    const blocked = await query.unfinishedCommitmentByPlayer([PlayerId('fa-finished')]);
    expect(blocked.has(PlayerId('fa-finished'))).toBe(false);
  });

  it('keeps the flag while the decided main draw is still inside its reveal window', async () => {
    // Same predicate the atomic claim uses: "concluded" means fully AIRED,
    // not merely decided — so the DTO's disabled-Sign state and the server's
    // refusal agree during the reveal window.
    await saveFree('fa-revealing-commit', 'Revealing Commitment');
    await saveFree('fa-revealing-opp', 'Revealing Opponent');
    await db.insert(schema.tournaments).values({
      id: 'commit-revealing',
      name: 'Revealing Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 2,
      drawSize: 16,
      hasStarted: true,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'commit-revealing',
      playerId: PlayerId('fa-revealing-commit'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'commit-revealing',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('fa-revealing-commit'),
      entrantB: PlayerId('fa-revealing-opp'),
      winnerId: PlayerId('fa-revealing-opp'),
      loserId: PlayerId('fa-revealing-commit'),
      setScores: [{ winnerGames: 6, loserGames: 3 }],
      scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000),
      revealSeconds: 900,
    });

    const blocked = await query.unfinishedCommitmentByPlayer([PlayerId('fa-revealing-commit')]);
    expect(blocked.get(PlayerId('fa-revealing-commit'))).toEqual({ id: 'commit-revealing', name: 'Revealing Open' });
  });
});

describe('DrizzlePlayerTournamentHistoryQuery (reveal-gated results)', () => {
  const history = new DrizzlePlayerTournamentHistoryQuery(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const agingPolicy = new StandardAgingPolicy();

  function saveNamed(id: string, name: string) {
    return playerRepository.save(
      Player.generateFillOnly(PlayerId(id), name, 20 * 52, agingPolicy.stageForAge(20 * 52), attributes(40), 'ES', 70, {
        speed: 70,
        stamina: 70,
        strength: 70,
      }),
    );
  }

  it('does not call a decided-but-not-yet-aired loss an elimination; it does once the reveal ends', async () => {
    await saveNamed('h-player', 'History Player');
    await saveNamed('h-opponent', 'History Opponent');
    await db.insert(schema.tournaments).values({
      id: 'h-t',
      name: 'History Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 2,
      drawSize: 16,
      hasStarted: true,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'h-t',
      playerId: PlayerId('h-player'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'h-t',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('h-player'),
      entrantB: PlayerId('h-opponent'),
      winnerId: PlayerId('h-opponent'),
      loserId: PlayerId('h-player'),
      setScores: [{ winnerGames: 6, loserGames: 4 }],
      scheduledStartAt: new Date(Date.now() + 60_000),
      revealSeconds: 900,
    });

    // Still inside the reveal window: the profile's Matches strip shows this
    // as "next up", so the history must NOT already report a loss.
    const before = await history.forPlayer(PlayerId('h-player'));
    const beforeEntry = before.find((e) => e.tournamentId === 'h-t')!;
    expect(beforeEntry.eliminated).toBe(false);
    expect(beforeEntry.roundsWon).toBe(0);

    // Same match, now long aired: the loss becomes visible everywhere.
    await db
      .update(schema.tournamentMatches)
      .set({ scheduledStartAt: new Date(Date.now() - 60 * 60_000) })
      .where(
        and(
          eq(schema.tournamentMatches.tournamentId, 'h-t'),
          eq(schema.tournamentMatches.draw, 'main'),
          eq(schema.tournamentMatches.matchIndex, 0),
        ),
      );
    const after = await history.forPlayer(PlayerId('h-player'));
    const afterEntry = after.find((e) => e.tournamentId === 'h-t')!;
    expect(afterEntry.eliminated).toBe(true);
  });
});

describe('DrizzleManagerXpRepository', () => {
  const repository = new DrizzleManagerXpRepository(db);

  it('balanceFor returns 0 for a manager who has never earned any XP', async () => {
    expect(await repository.balanceFor(ManagerId('never-earned'))).toBe(0);
  });

  it('credit accumulates across multiple calls, creating the row on first use', async () => {
    await repository.credit(ManagerId('m1'), 10);
    await repository.credit(ManagerId('m1'), 25);
    expect(await repository.balanceFor(ManagerId('m1'))).toBe(35);
  });

  it('spendXpIfSufficient deducts and succeeds when the balance covers the amount', async () => {
    await repository.credit(ManagerId('m1'), 100);
    const ok = await repository.spendXpIfSufficient(ManagerId('m1'), 40);
    expect(ok).toBe(true);
    expect(await repository.balanceFor(ManagerId('m1'))).toBe(60);
  });

  it('spendXpIfSufficient refuses and leaves the balance untouched when insufficient', async () => {
    await repository.credit(ManagerId('m1'), 10);
    const ok = await repository.spendXpIfSufficient(ManagerId('m1'), 999);
    expect(ok).toBe(false);
    expect(await repository.balanceFor(ManagerId('m1'))).toBe(10);
  });

  it('spendXpIfSufficient refuses for a manager with no balance row at all', async () => {
    const ok = await repository.spendXpIfSufficient(ManagerId('never-earned'), 1);
    expect(ok).toBe(false);
  });

  it(
    'under real concurrent spends against actual Postgres, only as many succeed as the balance actually covers',
    async () => {
      await repository.credit(ManagerId('m1'), 100);

      // 10 simultaneous spends of 30 each against a balance of 100 —
      // only 3 can possibly succeed (90 spent, 10 left over), and this
      // must hold under REAL concurrent connections, not just JS's
      // single-threadedness, the same proof
      // claimIfAvailable's concurrency test above establishes for the
      // talent-pool claim guard.
      const attempts = await Promise.all(
        Array.from({ length: 10 }, () => repository.spendXpIfSufficient(ManagerId('m1'), 30)),
      );

      const successes = attempts.filter((ok) => ok === true);
      expect(successes).toHaveLength(3);
      expect(await repository.balanceFor(ManagerId('m1'))).toBe(10);
    },
  );
});

describe('DrizzleTalentClaimAdapter', () => {
  const adapter = new DrizzleTalentClaimAdapter(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const xpRepository = new DrizzleManagerXpRepository(db);

  async function saveFreeAgent(id: string): Promise<void> {
    const player = Player.generateFillOnly(PlayerId(id), 'Marta Silva', 750, 'youth', attributes(30), 'BR', 55, {
      speed: 55,
      stamina: 55,
      strength: 55,
    });
    player.pullDomainEvents();
    await playerRepository.save(player);
  }

  /** Seeds a singles entry for `playerId` in a tournament whose main draw
   * is either still undecided (unfinished) or fully decided (finished). */
  async function seedSinglesCommitment(
    playerId: string,
    opponentId: string,
    finished: boolean,
    tournamentId: string,
  ): Promise<void> {
    await db.insert(schema.tournaments).values({
      id: tournamentId,
      name: 'Commitment Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 2,
      drawSize: 16,
      hasStarted: true,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId,
      playerId: PlayerId(playerId),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });
    await db.insert(schema.tournamentMatches).values({
      tournamentId,
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId(playerId),
      entrantB: PlayerId(opponentId),
      winnerId: finished ? PlayerId(opponentId) : null,
      loserId: finished ? PlayerId(playerId) : null,
      setScores: finished ? [{ winnerGames: 6, loserGames: 2 }] : null,
    });
  }

  /** Seeds a formed doubles pair for `playerId` whose doubles main draw is
   * either still undecided (unfinished) or fully decided (finished). */
  async function seedDoublesCommitment(
    playerId: string,
    partnerId: string,
    finished: boolean,
    tournamentId: string,
  ): Promise<void> {
    await db.insert(schema.tournaments).values({
      id: tournamentId,
      name: 'Doubles Commitment Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 2,
      drawSize: 16,
      doublesDrawSize: 8,
      hasStarted: true,
    });
    await db.insert(schema.tournamentDoublesPairs).values({
      tournamentId,
      pairId: 'commit-pair',
      playerA: PlayerId(playerId),
      playerB: PlayerId(partnerId),
    });
    await db.insert(schema.tournamentDoublesMatches).values({
      tournamentId,
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: 'commit-pair',
      entrantB: 'other-pair',
      winnerId: finished ? 'other-pair' : null,
      loserId: finished ? 'commit-pair' : null,
      setScores: finished ? [{ winnerGames: 6, loserGames: 3 }] : null,
    });
  }

  it('signs the free-agent player and debits XP together when the manager can afford it', async () => {
    await saveFreeAgent('tp1');
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 40);

    expect(outcome.kind).toBe('claimed');
    if (outcome.kind !== 'claimed') throw new Error('unreachable');
    expect(outcome.player.managerId).toBe(ManagerId('m1'));
    expect(outcome.player.fillOnly).toBe(false);
    expect(outcome.xpSpent).toBe(40);
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(60);

    const reloaded = await playerRepository.findById(PlayerId('tp1'));
    expect(reloaded!.managerId).toBe(ManagerId('m1'));
    expect(reloaded!.fillOnly).toBe(false);
  });

  it('refuses and spends nothing when the manager cannot afford the player', async () => {
    await saveFreeAgent('tp1');
    await xpRepository.credit(ManagerId('m1'), 10);

    const outcome = await adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 40);

    expect(outcome).toEqual({ kind: 'insufficient-xp', required: 40, balance: 10 });
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(10);

    // The player is untouched — still available for someone who CAN afford it.
    const reloaded = await playerRepository.findById(PlayerId('tp1'));
    expect(reloaded!.managerId).toBeNull();
    expect(reloaded!.fillOnly).toBe(true);
  });

  it('refuses when the player is already signed, rolling back the XP debit (no partial spend)', async () => {
    await playerRepository.save(Player.hire(PlayerId('tp1'), 'Marta Silva', 750, attributes(30), ManagerId('someone-else'), 'BR'));
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 40);

    expect(outcome).toEqual({ kind: 'player-unavailable' });
    // The XP debit that happened INSIDE the transaction was rolled back
    // along with everything else — this is the whole point of using a
    // real transaction instead of two independent conditional UPDATEs.
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(100);
  });

  it('refuses a free agent committed to an UNFINISHED singles tournament, spending nothing', async () => {
    // The deliberate design rule: a signing must always be clean, so a
    // free agent still committed to a tournament whose main draw hasn't
    // been played out cannot be signed. The predicate is part of the
    // atomic UPDATE itself (not a pre-check), so this holds under a
    // concurrent draw-seed too.
    await saveFreeAgent('tp1');
    await saveFreeAgent('tp-opp');
    await seedSinglesCommitment('tp1', 'tp-opp', false, 'commit-unfinished');
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 40);

    expect(outcome).toEqual({ kind: 'player-committed' });
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(100); // rolled back
    const reloaded = await playerRepository.findById(PlayerId('tp1'));
    expect(reloaded!.managerId).toBeNull();
    expect(reloaded!.fillOnly).toBe(true);
  });

  it('refuses a free agent committed to an UNFINISHED doubles draw (both entry paths)', async () => {
    await saveFreeAgent('tp1');
    await saveFreeAgent('tp-partner');
    await seedDoublesCommitment('tp1', 'tp-partner', false, 'commit-doubles-unfinished');
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 40);

    expect(outcome).toEqual({ kind: 'player-committed' });
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(100);
  });

  it('signs a free agent again once their only tournament main draw has FINISHED (and aired)', async () => {
    // The counterpart: a decided main draw is a concluded commitment, so
    // the player is signable again — the pool must not shrink forever.
    await saveFreeAgent('tp1');
    await saveFreeAgent('tp-opp');
    await seedSinglesCommitment('tp1', 'tp-opp', true, 'commit-finished');
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 40);

    expect(outcome.kind).toBe('claimed');
    if (outcome.kind !== 'claimed') throw new Error('unreachable');
    expect(outcome.player.managerId).toBe(ManagerId('m1'));
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(60);
  });

  it('still refuses a free agent whose main draw is decided but NOT yet aired (the boundary bug)', async () => {
    // The rule is "committed until the event's results have fully AIRED",
    // matching what the profile shows ("Next: vs … in 4:39:09"). A decided
    // final still inside its reveal window must not make the player
    // signable while they look mid-match.
    await saveFreeAgent('tp1');
    await saveFreeAgent('tp-opp');
    await db.insert(schema.tournaments).values({
      id: 'commit-revealing',
      name: 'Revealing Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 2,
      drawSize: 16,
      hasStarted: true,
    });
    await db.insert(schema.tournamentEntries).values({
      tournamentId: 'commit-revealing',
      playerId: PlayerId('tp1'),
      seed: null,
      entryType: 'da',
      draw: 'main',
    });
    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'commit-revealing',
      draw: 'main',
      roundNumber: 1,
      matchIndex: 0,
      entrantA: PlayerId('tp1'),
      entrantB: PlayerId('tp-opp'),
      winnerId: PlayerId('tp-opp'),
      loserId: PlayerId('tp1'),
      setScores: [{ winnerGames: 6, loserGames: 2 }],
      scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000),
      revealSeconds: 900,
    });
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 40);

    expect(outcome).toEqual({ kind: 'player-committed' });
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(100); // rolled back
    expect((await playerRepository.findById(PlayerId('tp1')))!.managerId).toBeNull();
  });

  it(
    'under real concurrent claims for TWO DIFFERENT free agents that together exceed the balance, exactly one succeeds',
    async () => {
      // Isolates the cross-table XP race specifically (independent of
      // the single-candidate claim race, which claimIfAvailable's own
      // concurrency test above already covers): two distinct available
      // free agents, each costing 60, against a shared balance of 100 —
      // only one of the two claims can possibly be affordable, and this
      // must hold under genuinely concurrent Postgres transactions, not
      // just JS's single-threadedness.
      await saveFreeAgent('tp1');
      await saveFreeAgent('tp2');
      await xpRepository.credit(ManagerId('m1'), 100);

      const [outcomeA, outcomeB] = await Promise.all([
        adapter.claimAndCharge(PlayerId('tp1'), ManagerId('m1'), 60),
        adapter.claimAndCharge(PlayerId('tp2'), ManagerId('m1'), 60),
      ]);

      const successes = [outcomeA, outcomeB].filter((o) => o.kind === 'claimed');
      expect(successes).toHaveLength(1);

      const finalBalance = await xpRepository.balanceFor(ManagerId('m1'));
      expect(finalBalance).toBe(40); // exactly one 60-cost claim went through
      expect(finalBalance).toBeGreaterThanOrEqual(0); // never went negative
    },
  );

  it(
    'under real concurrent sign attempts against one free agent, exactly one manager wins',
    async () => {
      await saveFreeAgent('tp1');
      await Promise.all(Array.from({ length: 10 }, (_, i) => xpRepository.credit(ManagerId(`m${i}`), 100)));

      const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, i) => adapter.claimAndCharge(PlayerId('tp1'), ManagerId(`m${i}`), 40)),
      );

      const successes = attempts.filter((result) => result.kind === 'claimed');
      expect(successes).toHaveLength(1);
      expect(attempts.filter((result) => result.kind === 'player-unavailable')).toHaveLength(9);

      const reloaded = await playerRepository.findById(PlayerId('tp1'));
      expect(reloaded!.managerId).toBe(successes[0].kind === 'claimed' ? successes[0].player.managerId : null);
      expect(reloaded!.fillOnly).toBe(false);
    },
  );
});

describe('DrizzleWeeklyEntryGuardAdapter', () => {
  const guard = new DrizzleWeeklyEntryGuardAdapter(db);
  const tournamentRepository = new DrizzleTournamentRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const week = { season: 1, week: 10 };

  async function savePlayer(id: string): Promise<void> {
    await playerRepository.save(Player.hire(PlayerId(id), 'Guard Player', 25 * 52, attributes(50), ManagerId('m1')));
  }

  async function saveOpenTournament(id: string, tier: 'challenger' | 'j100'): Promise<Tournament> {
    const tournament = Tournament.open({
      name: `Guard ${id}`,
      id: TournamentId(id),
      tier,
      ageBand: tier === 'j100' ? 'u16' : null,
      surface: 'hard',
      weekScheduled: week,
      drawSize: 32,
    });
    await tournamentRepository.save(tournament);
    return tournament;
  }

  it('refuses a second same-band entry when the player is already entered at cap 1', async () => {
    await savePlayer('gp1');
    const first = await saveOpenTournament('gt1', 'challenger');
    first.registerEntrant({ playerId: PlayerId('gp1'), seed: null });
    await tournamentRepository.save(first);
    await saveOpenTournament('gt2', 'challenger');

    const claimed = await guard.tryClaimEntry({
      playerId: PlayerId('gp1'),
      week,
      isJunior: false,
      tournamentId: TournamentId('gt2'),
      cap: 1,
    });
    expect(claimed).toBe(false);
  });

  it('under concurrent claims for TWO different tournaments at cap 1, exactly one succeeds', async () => {
    await savePlayer('gp1');
    await saveOpenTournament('gt1', 'challenger');
    await saveOpenTournament('gt2', 'challenger');

    const [a, b] = await Promise.all([
      guard.tryClaimEntry({ playerId: PlayerId('gp1'), week, isJunior: false, tournamentId: TournamentId('gt1'), cap: 1 }),
      guard.tryClaimEntry({ playerId: PlayerId('gp1'), week, isJunior: false, tournamentId: TournamentId('gt2'), cap: 1 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('allows re-claiming the SAME tournament — a retry is not blocked by its own earlier claim', async () => {
    await savePlayer('gp1');
    await saveOpenTournament('gt1', 'challenger');

    expect(
      await guard.tryClaimEntry({ playerId: PlayerId('gp1'), week, isJunior: false, tournamentId: TournamentId('gt1'), cap: 1 }),
    ).toBe(true);
    expect(
      await guard.tryClaimEntry({ playerId: PlayerId('gp1'), week, isJunior: false, tournamentId: TournamentId('gt1'), cap: 1 }),
    ).toBe(true);
  });

  it('counts junior and senior entries independently', async () => {
    await savePlayer('gp1');
    const senior = await saveOpenTournament('gt-s', 'challenger');
    senior.registerEntrant({ playerId: PlayerId('gp1'), seed: null });
    await tournamentRepository.save(senior);
    await saveOpenTournament('gt-j', 'j100');

    // The senior entry does NOT consume the junior band's weekly cap.
    expect(
      await guard.tryClaimEntry({ playerId: PlayerId('gp1'), week, isJunior: true, tournamentId: TournamentId('gt-j'), cap: 1 }),
    ).toBe(true);
  });
});

describe('DrizzleCoachConversionAdapter', () => {
  const adapter = new DrizzleCoachConversionAdapter(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const coachRepository = new DrizzleCoachRepository(db);
  const xpRepository = new DrizzleManagerXpRepository(db);
  const pairRepository = new DrizzleDoublesPairRepository(db);

  async function saveRosteredPlayer(id: string, managerId: ManagerId): Promise<void> {
    const player = Player.hire(PlayerId(id), 'Marta Silva', 25 * 52, attributes(60), managerId, 'BR');
    player.pullDomainEvents();
    await playerRepository.save(player);
  }

  function conversionInput(playerId: string, managerId: string, coachId: string) {
    return {
      playerId: PlayerId(playerId),
      managerId: ManagerId(managerId),
      coachId: CoachId(coachId),
      xpCost: 40,
      coachRating: 72,
      sourcePlayerName: 'Marta Silva',
    };
  }

  it('converts atomically: debits XP, releases the player, dissolves pairs, and creates the coach', async () => {
    await saveRosteredPlayer('cp1', ManagerId('m1'));
    await saveRosteredPlayer('cp2', ManagerId('m1'));
    await xpRepository.credit(ManagerId('m1'), 100);
    await pairRepository.save(DoublesPair.activate(PairId('pair-1'), PlayerId('cp1'), PlayerId('cp2')));

    const outcome = await adapter.convertAndCharge(conversionInput('cp1', 'm1', 'coach1'));

    expect(outcome.kind).toBe('converted');
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(60);
    expect((await playerRepository.findById(PlayerId('cp1')))!.managerId).toBeNull();
    const coaches = await coachRepository.findByManager(ManagerId('m1'));
    expect(coaches).toHaveLength(1);
    expect(coaches[0].coachRating).toBe(72);
    expect((await pairRepository.findById(PairId('pair-1')))!.isDissolved).toBe(true);
  });

  it('refuses and spends nothing when the manager cannot afford the conversion', async () => {
    await saveRosteredPlayer('cp1', ManagerId('m1'));
    await xpRepository.credit(ManagerId('m1'), 10);

    const outcome = await adapter.convertAndCharge(conversionInput('cp1', 'm1', 'coach1'));

    expect(outcome).toEqual({ kind: 'insufficient-xp', required: 40, balance: 10 });
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(10);
    expect((await playerRepository.findById(PlayerId('cp1')))!.managerId).toBe(ManagerId('m1'));
    expect(await coachRepository.findByManager(ManagerId('m1'))).toHaveLength(0);
  });

  it('rolls back the XP debit when the player turns out not to be owned by the manager', async () => {
    await saveRosteredPlayer('cp1', ManagerId('someone-else'));
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.convertAndCharge(conversionInput('cp1', 'm1', 'coach1'));

    // The XP debit already applied inside the transaction is undone by
    // the rollback — the whole reason this is one transaction instead of
    // a spend-then-release sequence in application code.
    expect(outcome).toEqual({ kind: 'player-unavailable' });
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(100);
    expect((await playerRepository.findById(PlayerId('cp1')))!.managerId).toBe(ManagerId('someone-else'));
    expect(await coachRepository.findByManager(ManagerId('m1'))).toHaveLength(0);
  });

  it('under concurrent conversions of the SAME player, exactly one succeeds and the XP is charged once', async () => {
    await saveRosteredPlayer('cp1', ManagerId('m1'));
    await xpRepository.credit(ManagerId('m1'), 100);

    const [a, b] = await Promise.all([
      adapter.convertAndCharge(conversionInput('cp1', 'm1', 'coach1')),
      adapter.convertAndCharge(conversionInput('cp1', 'm1', 'coach2')),
    ]);

    expect([a, b].filter((o) => o.kind === 'converted')).toHaveLength(1);
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(60);
    expect(await coachRepository.findByManager(ManagerId('m1'))).toHaveLength(1);
  });
});

describe('DrizzleCoachRepository', () => {
  const repository = new DrizzleCoachRepository(db);

  it('round-trips a converted coach', async () => {
    const coach = Coach.convert(CoachId('coach1'), ManagerId('m1'), 72, PlayerId('p1'), 'Marta Silva');
    await repository.save(coach);

    const found = await repository.findByManager(ManagerId('m1'));
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(CoachId('coach1'));
    expect(found[0].coachRating).toBe(72);
    expect(found[0].sourcePlayerId).toBe(PlayerId('p1'));
    expect(found[0].sourcePlayerName).toBe('Marta Silva');
  });

  it('findByManager returns an empty array for a manager with no coaches', async () => {
    expect(await repository.findByManager(ManagerId('nobody'))).toEqual([]);
  });

  it('findByManager only returns coaches belonging to that manager', async () => {
    await repository.save(Coach.convert(CoachId('coach1'), ManagerId('m1'), 50, PlayerId('p1'), 'A'));
    await repository.save(Coach.convert(CoachId('coach2'), ManagerId('m2'), 60, PlayerId('p2'), 'B'));

    expect((await repository.findByManager(ManagerId('m1'))).map((c) => c.id)).toEqual(['coach1']);
    expect((await repository.findByManager(ManagerId('m2'))).map((c) => c.id)).toEqual(['coach2']);
  });
});

describe('DrizzleDoublesPairRepository', () => {
  const repository = new DrizzleDoublesPairRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);

  async function savePlayers(ids: PlayerId[]): Promise<void> {
    for (const id of ids) {
      await playerRepository.save(Player.hire(id, id, 25 * 52, attributes(50), ManagerId('m1')));
    }
  }

  it('round-trips a pair and its status transition (upsert)', async () => {
    await savePlayers([PlayerId('a'), PlayerId('b')]);

    const pair = DoublesPair.propose(PairId('pair1'), PlayerId('a'), PlayerId('b'));
    await repository.save(pair);

    const found = await repository.findById(PairId('pair1'));
    expect(found).not.toBeNull();
    expect(found!.status).toBe('pending');
    expect(found!.involves(PlayerId('a'))).toBe(true);
    expect(found!.partnerOf(PlayerId('a'))).toBe(PlayerId('b'));

    // Accept → active, saved in place (upsert, no second row).
    found!.accept();
    await repository.save(found!);

    const reloaded = await repository.findById(PairId('pair1'));
    expect(reloaded!.status).toBe('active');

    // findByPlayer/findByPlayers see it from both sides.
    expect((await repository.findByPlayer(PlayerId('a'))).map((p) => p.id)).toEqual(['pair1']);
    expect((await repository.findByPlayer(PlayerId('b'))).map((p) => p.id)).toEqual(['pair1']);
    expect((await repository.findByPlayers([PlayerId('a')])).map((p) => p.id)).toEqual(['pair1']);
  });

  it('findByPlayers filters to pairs involving ANY of the given players', async () => {
    await savePlayers([PlayerId('a'), PlayerId('b'), PlayerId('c'), PlayerId('d')]);

    await repository.save(DoublesPair.activate(PairId('p-ab'), PlayerId('a'), PlayerId('b')));
    await repository.save(DoublesPair.activate(PairId('p-cd'), PlayerId('c'), PlayerId('d')));

    const forAandC = await repository.findByPlayers([PlayerId('a'), PlayerId('c')]);
    expect(forAandC.map((p) => p.id).sort()).toEqual(['p-ab', 'p-cd']);

    const forAonly = await repository.findByPlayers([PlayerId('a')]);
    expect(forAonly.map((p) => p.id)).toEqual(['p-ab']);
  });

  it('findByPlayer returns an empty array for a player in no pair', async () => {
    await savePlayers([PlayerId('lonely')]);
    expect(await repository.findByPlayer(PlayerId('lonely'))).toEqual([]);
  });
});

describe('DrizzleDoublesTitleRepository + DrizzleDoublesPeakRankingRepository', () => {
  const titles = new DrizzleDoublesTitleRepository(db);
  const peaks = new DrizzleDoublesPeakRankingRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);
  const tournamentRepository = new DrizzleTournamentRepository(db);

  it('round-trips a doubles title and a doubles peak', async () => {
    await playerRepository.save(Player.hire(PlayerId('a'), 'Player A', 20 * 52, attributes(30), ManagerId('m1')));
    await playerRepository.save(Player.hire(PlayerId('b'), 'Player B', 20 * 52, attributes(30), ManagerId('m1')));
    await tournamentRepository.save(
      Tournament.open({ name: 'Test Doubles Championship', id: TournamentId('tdt1'), tier: 'challenger', surface: 'hard', weekScheduled: { season: 2, week: 19 }, drawSize: 16, doublesDrawSize: 4 }),
    );

    await titles.append({
      tournamentId: TournamentId('tdt1'),
      playerA: PlayerId('a'),
      playerB: PlayerId('b'),
      tier: 'challenger',
      ageBand: null,
      weekEarned: { season: 2, week: 19 },
    });
    const found = await titles.findByPlayer(PlayerId('a'));
    expect(found).toHaveLength(1);
    expect(found[0].playerB).toBe(PlayerId('b'));
    expect(await titles.findByPlayer(PlayerId('b'))).toHaveLength(1);

    await peaks.upsert({ playerId: PlayerId('a'), band: 'senior', peakPoints: 62.5, peakAsOfWeek: { season: 2, week: 19 } });
    const peak = await peaks.findOne(PlayerId('a'), 'senior');
    expect(peak!.peakPoints).toBe(62.5);
    expect(peaks.findOne(PlayerId('b'), 'senior')).resolves.toBeNull();
  });
});

describe('DrizzleMastersCupRepository', () => {
  const repository = new DrizzleMastersCupRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);

  it('round-trips a Masters Cup (groups + knockout) as a whole', async () => {
    for (let i = 1; i <= 8; i++) {
      await playerRepository.save(Player.hire(PlayerId(`p${i}`), `Player ${i}`, 25 * 52, attributes(50), ManagerId('m1')));
    }

    const cup = MastersCup.open({
      id: TournamentId('mc1'),
      season: 1,
      weekScheduled: { season: 1, week: 40 },
      surface: 'hard',
      singlesEntrants: Array.from({ length: 8 }, (_, i) => PlayerId(`p${i + 1}`)),
      doublesEntrants: Array.from({ length: 8 }, (_, i) => ({
        pairId: PairId(`d${i + 1}`),
        playerA: PlayerId(`p${i + 1}`),
        playerB: PlayerId(`p${(i % 4) + 1}`),
      })),
    });
    await repository.save(cup);

    const loaded = await repository.findBySeason(1);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('mc1');
    expect(loaded!.singlesEntrants).toHaveLength(8);
    expect(loaded!.singlesGroups).toHaveLength(2);
    expect(loaded!.singlesGroups[0].matches).toHaveLength(6);
    expect(loaded!.doublesGroups).toHaveLength(2);
    expect(loaded!.hasKnockout).toBe(false);

    // Mutate (record a group outcome) and save again — the jsonb round-
    // trip preserves outcomes.
    const m = loaded!.singlesGroups[0].matches[0];
    loaded!.recordSinglesGroupMatchOutcome(0, 0, { winner: m.entrantA, loser: m.entrantB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
    await repository.save(loaded!);

    const reloaded = await repository.findBySeason(1);
    expect(reloaded!.singlesGroups[0].matches[0].outcome).not.toBeNull();
  });
});

describe('DrizzleWorldTeamCupRepository', () => {
  const repository = new DrizzleWorldTeamCupRepository(db);
  const playerRepository = new DrizzlePlayerRepository(db);

  it('round-trips a World Team Cup (teams/groups/ties) as a whole, including rubber outcomes', async () => {
    const countries = ['BR', 'US', 'FR', 'JP', 'AU', 'DE', 'AR', 'GB'];
    const teamIds: Array<[PlayerId, PlayerId]> = [];
    let n = 1;
    for (const _ of countries) {
      const a = PlayerId(`p${n++}`);
      const b = PlayerId(`p${n++}`);
      teamIds.push([a, b]);
      await playerRepository.save(Player.hire(a, `Player ${n - 2}`, 25 * 52, attributes(50), ManagerId('m1')));
      await playerRepository.save(Player.hire(b, `Player ${n - 1}`, 25 * 52, attributes(50), ManagerId('m1')));
    }

    const cup = WorldTeamCup.open({
      id: TournamentId('wtc1'),
      season: 1,
      weekScheduled: { season: 1, week: 42 },
      surface: 'clay',
      teams: countries.map((c, i) => ({ country: c, players: teamIds[i] })),
    });
    await repository.save(cup);

    const loaded = await repository.findBySeason(1);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('wtc1');
    expect(loaded!.teams).toHaveLength(8);
    // 8 teams -> two groups of 4, each with the full round-robin of 6 ties.
    expect(loaded!.groups).toHaveLength(2);
    expect(loaded!.groups[0].ties).toHaveLength(6);
    expect(loaded!.groups[1].ties).toHaveLength(6);
    expect(loaded!.hasKnockout).toBe(false);
    // Every tie carries exactly three rubbers: two singles then a doubles.
    for (const tie of loaded!.groups[0].ties) {
      expect(tie.rubbers).toHaveLength(3);
      expect(tie.rubbers[0].kind).toBe('singles');
      expect(tie.rubbers[1].kind).toBe('singles');
      expect(tie.rubbers[2].kind).toBe('doubles');
    }

    // Mutate (record the first group's first tie's first rubber) and
    // save again — the jsonb round-trip preserves outcomes.
    const tie = loaded!.groups[0].ties[0];
    const rubber = tie.rubbers[0];
    if (rubber.kind === 'singles') {
      loaded!.recordRubberOutcome(tie, 0, {
        winner: rubber.playerA,
        loser: rubber.playerB,
        setScores: [{ winnerGames: 6, loserGames: 2 }],
      });
    }
    await repository.save(loaded!);

    const reloaded = await repository.findBySeason(1);
    expect(reloaded!.groups[0].ties[0].rubbers[0].outcome).not.toBeNull();
    expect(reloaded!.groups[0].ties[0].winner).toBeNull(); // 1-0, not decided yet
  });
});

/** Minimal fakes for the two ports EnsureFillOnlyPopulationUseCase needs
 * that have no real adapter under test here — the player/world
 * repositories driving these cases are the REAL Drizzle ones. */
class SequentialFillerIdGenerator implements IdGeneratorPort {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    return `retired-filler-gen-${this.counter}`;
  }
}

class NoopEventPublisher implements EventPublisherPort {
  async publish(): Promise<void> {}
}

const realRandom: RandomSource = { next: () => Math.random() };

/**
 * Real-Postgres regression coverage for the retired-filler bug: every
 * filler filter used `fillOnly` alone, and because retirement keeps the
 * `players` row (and `fillOnly`) forever, a retired player still counted
 * toward the population floor and could still be selected to pad a
 * real draw. The application unit tests use in-memory fakes, so they
 * never exercise the real `findAll()` read path that genuinely returns
 * retired rows — these cases do, against an actual database.
 */
describe('retired players are never draw fillers (real Postgres)', () => {
  const playerRepository = new DrizzlePlayerRepository(db);
  const worldRepository = new DrizzleGameWorldRepository(db);
  const tournamentRepository = new DrizzleTournamentRepository(db);
  const rankingLedgerRepository = new DrizzleRankingLedgerRepository(db);

  function rankingsFor(worldId: WorldId): Record<RankingBand, RankPositionQuery> {
    return {
      senior: new RankPositionQuery(rankingLedgerRepository, worldRepository, worldId, 'senior'),
      u18: new RankPositionQuery(rankingLedgerRepository, worldRepository, worldId, 'u18'),
      u16: new RankPositionQuery(rankingLedgerRepository, worldRepository, worldId, 'u16'),
      u14: new RankPositionQuery(rankingLedgerRepository, worldRepository, worldId, 'u14'),
    };
  }

  function retiredFiller(id: string): Player {
    const player = Player.generateFillOnly(PlayerId(id), `Retired ${id}`, 25 * 52, 'retired', attributes(40), 'US');
    player.pullDomainEvents();
    return player;
  }

  it('does not count a retired fill-only player toward EnsureFillOnlyPopulationUseCase floors', async () => {
    const worldId = WorldId('retired-floor-world');
    await worldRepository.save(GameWorld.create(worldId, { season: 1, week: 1 }));

    // A retired senior-age fill-only player. Without the fix this one
    // row counts as live senior supply, so only totalFloor - 1 players
    // would be generated.
    await playerRepository.save(retiredFiller('retired-senior-filler'));

    const useCase = new EnsureFillOnlyPopulationUseCase(
      worldRepository,
      playerRepository,
      new NoopEventPublisher(),
      new StandardPlayerGenerationPolicy(),
      realRandom,
      new SequentialFillerIdGenerator(),
      new StandardAgingPolicy(),
    );

    const totalFloor = FILL_ONLY_FLOORS.reduce((sum, floor) => sum + floor.minimum, 0);
    const result = await useCase.execute({ worldId });

    expect(result.generated).toBe(totalFloor);

    const liveSenior = (await playerRepository.findAll())
      .filter((p) => p.fillOnly && !p.isRetired())
      .filter((p) => juniorEligibilityForAge(p.seasonAgeAnchorWeeks) === 'senior');
    expect(liveSenior.length).toBe(FILL_ONLY_FLOORS.find((floor) => floor.band === 'senior')!.minimum);
  });

  it('never selects a retired fill-only player to pad a started tournament draw', async () => {
    const worldId = WorldId('retired-selection-world');
    await worldRepository.save(GameWorld.create(worldId, { season: 1, week: 1 }));

    // One retired and one live candidate, both senior, both unclaimed.
    // With the bug both are eligible and fillSlots selects both (filled
    // === 2); fixed, only the live one is available (filled === 1).
    await playerRepository.save(retiredFiller('retired-filler'));
    const live = Player.generateFillOnly(PlayerId('live-filler'), 'Live Filler', 25 * 52, 'prime', attributes(40), 'US');
    live.pullDomainEvents();
    await playerRepository.save(live);

    const tournament = Tournament.open({
      name: 'Retired Filler Regression Open',
      id: TournamentId('retired-selection-t'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    tournament.pullDomainEvents();
    await tournamentRepository.save(tournament);

    const useCase = new StartDueTournamentsUseCase(
      tournamentRepository,
      worldRepository,
      playerRepository,
      new BracketGenerator(),
      rankingsFor(worldId),
    );
    const result = await useCase.execute({ worldId });

    expect(result.filled).toBe(1);

    const reloaded = await tournamentRepository.findById(TournamentId('retired-selection-t'));
    const entrantIds = reloaded!.entrants.map((entrant) => entrant.playerId as string);
    expect(entrantIds).toContain('live-filler');
    expect(entrantIds).not.toContain('retired-filler');
  });
});

describe('DrizzleNotificationDeliveryRepository + DrizzleNotificationPreferenceRepository', () => {
  const deliveries = new DrizzleNotificationDeliveryRepository(db);
  const preferences = new DrizzleNotificationPreferenceRepository(db);
  const managerId = ManagerId('notif-m1');
  const KIND = 'results_digest';

  // The notification tables FK managers.id, so a real manager row must
  // exist. This suite never truncates managers, so upsert idempotently.
  beforeEach(async () => {
    await db
      .insert(schema.managers)
      .values({
        id: managerId,
        authSubject: 'notif-subject',
        displayName: 'Notif Manager',
        publicHandle: 'notif-manager',
      })
      .onConflictDoNothing();
  });

  it('tryClaim is true exactly once per (manager, kind, window)', async () => {
    const coveredUntil = new Date('2026-01-10T00:00:00.000Z');
    expect(await deliveries.tryClaim(managerId, KIND, '2026-01-10', coveredUntil)).toBe(true);
    expect(await deliveries.tryClaim(managerId, KIND, '2026-01-10', coveredUntil)).toBe(false);
    // A different window is a different slot.
    expect(await deliveries.tryClaim(managerId, KIND, '2026-01-11', coveredUntil)).toBe(true);
  });

  it('previousCoveredUntil only advances on SENT deliveries', async () => {
    const first = new Date('2026-01-10T00:00:00.000Z');
    const second = new Date('2026-01-11T00:00:00.000Z');

    expect(await deliveries.previousCoveredUntil(managerId, KIND)).toBeNull();
    await deliveries.tryClaim(managerId, KIND, '2026-01-10', first);
    // Claimed but not sent yet — the cursor has not advanced.
    expect(await deliveries.previousCoveredUntil(managerId, KIND)).toBeNull();

    await deliveries.markSent(managerId, KIND, '2026-01-10');
    expect((await deliveries.previousCoveredUntil(managerId, KIND))!.toISOString()).toBe(first.toISOString());

    await deliveries.tryClaim(managerId, KIND, '2026-01-11', second);
    await deliveries.markFailed(managerId, KIND, '2026-01-11');
    // A failed send must NOT advance the cursor — still the first window.
    expect((await deliveries.previousCoveredUntil(managerId, KIND))!.toISOString()).toBe(first.toISOString());
  });

  it('markSent / markFailed round-trip the status column', async () => {
    const t = new Date('2026-01-12T00:00:00.000Z');
    await deliveries.tryClaim(managerId, KIND, 'sent-window', t);
    await deliveries.markSent(managerId, KIND, 'sent-window');
    const [sentRow] = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(and(eq(schema.notificationDeliveries.managerId, managerId), eq(schema.notificationDeliveries.windowKey, 'sent-window')));
    expect(sentRow.status).toBe('sent');
    expect(sentRow.sentAt).not.toBeNull();

    await deliveries.tryClaim(managerId, KIND, 'failed-window', t);
    await deliveries.markFailed(managerId, KIND, 'failed-window');
    const [failedRow] = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(and(eq(schema.notificationDeliveries.managerId, managerId), eq(schema.notificationDeliveries.windowKey, 'failed-window')));
    expect(failedRow.status).toBe('failed');
    expect(failedRow.sentAt).toBeNull();
  });

  it('preference defaults to opted-in (false) and round-trips an opt-out', async () => {
    expect(await preferences.isOptedOut(managerId)).toBe(false);
    await preferences.setOptOut(managerId, true);
    expect(await preferences.isOptedOut(managerId)).toBe(true);
    await preferences.setOptOut(managerId, false);
    expect(await preferences.isOptedOut(managerId)).toBe(false);
  });
});

describe('DrizzleManagerDigestQuery', () => {
  const digestQuery = new DrizzleManagerDigestQuery(db);
  const digestPlayerRepository = new DrizzlePlayerRepository(db);
  const managerId = ManagerId('digest-m1');
  const since = new Date('2026-01-10T00:00:00.000Z');
  const until = new Date('2026-01-11T00:00:00.000Z');

  async function saveFillOnly(id: string, name: string): Promise<void> {
    const player = Player.generateFillOnly(PlayerId(id), name, 20 * 52, 'prime', attributes(45), 'LV');
    player.pullDomainEvents();
    await digestPlayerRepository.save(player);
  }

  beforeEach(async () => {
    await db
      .insert(schema.managers)
      .values({
        id: managerId,
        authSubject: 'digest-subject',
        displayName: 'Digest Manager',
        publicHandle: 'digest-manager',
      })
      .onConflictDoNothing();

    const alice = Player.hire(PlayerId('digest-alice'), 'Alice Digest', 20 * 52, attributes(60), managerId, 'LV');
    alice.pullDomainEvents();
    await digestPlayerRepository.save(alice);
    await saveFillOnly('digest-opp-a', 'Opponent A');
    await saveFillOnly('digest-opp-b', 'Opponent B');
    await saveFillOnly('digest-opp-c', 'Opponent C');
    await saveFillOnly('digest-opp-d', 'Opponent D');

    await db.insert(schema.tournaments).values({
      id: 'digest-t1',
      name: 'Riga Digest Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 5,
      drawSize: 16,
    });

    await db.insert(schema.tournamentMatches).values([
      // In window, main draw, decided: scheduled_start_at 12:00 +
      // reveal_seconds 600 -> airedAt 12:10.
      {
        tournamentId: 'digest-t1',
        draw: 'main',
        roundNumber: 3,
        matchIndex: 0,
        entrantA: PlayerId('digest-alice'),
        entrantB: PlayerId('digest-opp-a'),
        winnerId: PlayerId('digest-alice'),
        loserId: PlayerId('digest-opp-a'),
        setScores: [{ winnerGames: 6, loserGames: 4 }],
        scheduledStartAt: new Date('2026-01-10T12:00:00.000Z'),
        revealSeconds: 600,
      },
      // Decided but OUT of window.
      {
        tournamentId: 'digest-t1',
        draw: 'main',
        roundNumber: 2,
        matchIndex: 0,
        entrantA: PlayerId('digest-alice'),
        entrantB: PlayerId('digest-opp-b'),
        winnerId: PlayerId('digest-alice'),
        loserId: PlayerId('digest-opp-b'),
        setScores: [{ winnerGames: 6, loserGames: 1 }],
        scheduledStartAt: new Date('2026-01-08T12:00:00.000Z'),
        revealSeconds: 600,
      },
      // Decided, in window, but a QUALIFYING draw match — must not appear.
      {
        tournamentId: 'digest-t1',
        draw: 'qualifying',
        roundNumber: 1,
        matchIndex: 0,
        entrantA: PlayerId('digest-alice'),
        entrantB: PlayerId('digest-opp-c'),
        winnerId: PlayerId('digest-alice'),
        loserId: PlayerId('digest-opp-c'),
        setScores: [{ winnerGames: 6, loserGames: 2 }],
        scheduledStartAt: new Date('2026-01-10T12:00:00.000Z'),
        revealSeconds: 600,
      },
      // Undecided main-draw match — the "next" pending match.
      {
        tournamentId: 'digest-t1',
        draw: 'main',
        roundNumber: 1,
        matchIndex: 1,
        entrantA: PlayerId('digest-alice'),
        entrantB: PlayerId('digest-opp-d'),
        winnerId: null,
        loserId: null,
        setScores: null,
        scheduledStartAt: null,
        revealSeconds: null,
      },
    ]);

    await db.insert(schema.titles).values({
      tournamentId: 'digest-t1',
      playerId: PlayerId('digest-alice'),
      tier: 'tour',
      ageBand: null,
      seasonEarned: 1,
      weekEarned: 5,
      createdAt: new Date('2026-01-10T18:00:00.000Z'),
    });
  });

  it('lists every manager with a roster', async () => {
    expect(await digestQuery.listManagerIds()).toContain(managerId);
  });

  it('returns only in-window, main-draw, decided results keyed on scheduled_start_at + reveal', async () => {
    const data = await digestQuery.load({ managerId, since, until });
    const alice = data.find((p) => p.playerId === PlayerId('digest-alice'))!;

    // Exactly one qualifying result — the out-of-window, qualifying-draw
    // and undecided matches are all excluded.
    expect(alice.results).toHaveLength(1);
    const [only] = alice.results;
    expect(only.matchId).toBe('digest-t1:main:3:0');
    expect(only.airedAt.toISOString()).toBe('2026-01-10T12:10:00.000Z');
    expect(only.opponentName).toBe('Opponent A');
    expect(only.won).toBe(true);
    expect(only.tournamentName).toBe('Riga Digest Open');

    // The undecided match is the pending "next", not a result.
    expect(alice.next).not.toBeNull();
    expect(alice.next!.opponentName).toBe('Opponent D');
    expect(alice.next!.scheduledStartAt).toBeNull();

    // The title created inside the window is surfaced.
    expect(alice.titles.map((t) => t.tournamentId)).toEqual(['digest-t1']);
  });

  it('places a boundary match correctly on the half-open window', async () => {
    // Re-point the in-window match to air exactly at `since` (excluded)
    // and confirm it drops out. This proves the boundary is `(since, until]`.
    await db
      .update(schema.tournamentMatches)
      .set({ scheduledStartAt: since, revealSeconds: 0 })
      .where(
        and(
          eq(schema.tournamentMatches.tournamentId, 'digest-t1'),
          eq(schema.tournamentMatches.draw, 'main'),
          eq(schema.tournamentMatches.roundNumber, 3),
          eq(schema.tournamentMatches.matchIndex, 0),
        ),
      );

    const data = await digestQuery.load({ managerId, since, until });
    const alice = data.find((p) => p.playerId === PlayerId('digest-alice'))!;
    expect(alice.results).toHaveLength(0);
  });
});

describe('SendManagerDigestsUseCase (real Postgres, logging adapter)', () => {
  const managerId = ManagerId('digest-e2e-m1');
  const playerRepository = new DrizzlePlayerRepository(db);
  const deliveries = new DrizzleNotificationDeliveryRepository(db);
  const preferences = new DrizzleNotificationPreferenceRepository(db);
  const ledger = new DrizzleRankingLedgerRepository(db);
  const worlds = new DrizzleGameWorldRepository(db);
  const worldId = WorldId('main');
  const rankPositionByBand: Record<RankingBand, RankPositionQuery> = {
    senior: new RankPositionQuery(ledger, worlds, worldId, 'senior'),
    u14: new RankPositionQuery(ledger, worlds, worldId, 'u14'),
    u16: new RankPositionQuery(ledger, worlds, worldId, 'u16'),
    u18: new RankPositionQuery(ledger, worlds, worldId, 'u18'),
  };

  // Deterministic contact + a captured log sink, so the test can assert
  // both the delivered message and that the transport was the LOGGING
  // one (no network anywhere in this suite).
  const contacts: ManagerContactPort = { emailFor: async () => 'digest-e2e@example.com' };
  const logEntries: Array<{ message: string; payload: Record<string, unknown> }> = [];
  const notifications = new LoggingNotificationAdapter((message, payload) => logEntries.push({ message, payload }));

  const useCase = new SendManagerDigestsUseCase(
    new DrizzleManagerDigestQuery(db),
    deliveries,
    preferences,
    contacts,
    notifications,
    rankPositionByBand,
  );

  // Fixed "now" so the digest window is (2026-01-10T00:00, 2026-01-11T00:00].
  const now = new Date('2026-01-11T00:00:00.000Z');
  const windowKey = '2026-01-11';

  beforeEach(async () => {
    logEntries.length = 0;
    await db
      .insert(schema.managers)
      .values({
        id: managerId,
        authSubject: 'digest-e2e-subject',
        displayName: 'Digest E2E Manager',
        publicHandle: 'digest-e2e-manager',
      })
      .onConflictDoNothing();

    const alice = Player.hire(PlayerId('digest-e2e-alice'), 'Alice E2E', 20 * 52, attributes(60), managerId, 'LV');
    alice.pullDomainEvents();
    await playerRepository.save(alice);

    const opponent = Player.generateFillOnly(PlayerId('digest-e2e-opp'), 'Opponent E2E', 20 * 52, 'prime', attributes(45), 'LV');
    opponent.pullDomainEvents();
    await playerRepository.save(opponent);

    await db.insert(schema.tournaments).values({
      id: 'digest-e2e-t1',
      name: 'E2E Digest Open',
      tier: 'tour',
      surface: 'hard',
      seasonScheduled: 1,
      weekScheduled: 5,
      drawSize: 16,
    });

    await db.insert(schema.tournamentMatches).values({
      tournamentId: 'digest-e2e-t1',
      draw: 'main',
      roundNumber: 3,
      matchIndex: 0,
      entrantA: PlayerId('digest-e2e-alice'),
      entrantB: PlayerId('digest-e2e-opp'),
      winnerId: PlayerId('digest-e2e-alice'),
      loserId: PlayerId('digest-e2e-opp'),
      setScores: [{ winnerGames: 6, loserGames: 4 }],
      scheduledStartAt: new Date('2026-01-10T12:00:00.000Z'),
      revealSeconds: 600,
    });
  });

  it('claims, sends once through the logging adapter, and is a no-op on a second same-day run', async () => {
    const first = await useCase.execute({ now, windowKey });
    expect(first).toEqual({ sent: 1, skipped: 0, failed: 0 });

    // The logging transport recorded exactly one {to, subject}.
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].payload).toMatchObject({
      to: 'digest-e2e@example.com',
      subject: 'Tennis Manager - your weekly results digest',
    });

    // The claim row exists and is marked sent.
    const rows = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.managerId, managerId));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('results_digest');
    expect(rows[0].windowKey).toBe(windowKey);
    expect(rows[0].status).toBe('sent');

    // A second same-day run finds the window already claimed and sends nothing.
    const second = await useCase.execute({ now, windowKey });
    expect(second.sent).toBe(0);
    expect(second.failed).toBe(0);
    expect(logEntries).toHaveLength(1);
  });
});

describe('DrizzleManagerAccountCreationAdapter', () => {
  const creation = new DrizzleManagerAccountCreationAdapter(db);
  const xp = new DrizzleManagerXpRepository(db);

  it('creates the account and grants the starter balance for exactly one of N concurrent first-requests', async () => {
    // N distinct candidate accounts for the SAME auth subject — the real
    // production shape, where every parallel first-request mints its own
    // random manager id and none has seen the other's write yet.
    const authSubject = `macct-race-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const starter = 500;
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      id: ManagerId(`macct-${authSubject}-${i}`),
      authSubject,
      displayName: 'Race Manager',
      publicHandle: `macct-handle-${authSubject}-${i}`,
      status: 'active' as const,
    }));

    const results = await Promise.all(candidates.map((c) => creation.createWithStarterXp(c, starter)));

    // Exactly one call created (and therefore granted); all the rest saw
    // the same persisted winner row.
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.find((r) => r.created)!;
    expect(new Set(results.map((r) => r.account.id))).toEqual(new Set([winner.account.id]));
    expect(await xp.balanceFor(winner.account.id)).toBe(starter);
  });

  it('never re-grants for an already-existing account', async () => {
    const authSubject = `macct-again-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const account = {
      id: ManagerId(`${authSubject}-id`),
      authSubject,
      displayName: 'Returning Manager',
      publicHandle: `macct-again-handle-${authSubject}`,
      status: 'active' as const,
    };

    const first = await creation.createWithStarterXp(account, 500);
    expect(first.created).toBe(true);
    await xp.spendXpIfSufficient(account.id, 300);

    const second = await creation.createWithStarterXp(account, 500);
    expect(second.created).toBe(false);
    expect(await xp.balanceFor(account.id)).toBe(200); // 500 granted once, minus 300
  });
});

