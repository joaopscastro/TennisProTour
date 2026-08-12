import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { entryTypeOf, ManagerId, PlayerId, TournamentId, TournamentEntrant } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import {
  PlayerAttributes,
  Skill,
  SurfaceAffinities,
} from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { Coach, CoachId } from '@tennis-manager/domain';
import * as schema from '../../db/schema';
import { testConnectionString } from '../../db/testConnection';
import { DrizzlePlayerRepository } from './DrizzlePlayerRepository';
import { DrizzleTrainingScheduleRepository } from './DrizzleTrainingScheduleRepository';
import { DrizzleTournamentRepository } from './DrizzleTournamentRepository';
import { DrizzleRankingLedgerRepository } from './DrizzleRankingLedgerRepository';
import { DrizzleManagerXpRepository } from './DrizzleManagerXpRepository';
import { DrizzleTalentClaimAdapter } from './DrizzleTalentClaimAdapter';
import { DrizzleCoachRepository } from './DrizzleCoachRepository';
import { DrizzlePeakRankingRepository } from './DrizzlePeakRankingRepository';
import { DrizzleTitleRepository } from './DrizzleTitleRepository';

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
  await db.delete(schema.rankingLedger);
  await db.delete(schema.titles);
  await db.delete(schema.peakRankings);
  await db.delete(schema.trainingSchedule);
  await db.delete(schema.tournamentMatches);
  await db.delete(schema.tournamentEntries);
  await db.delete(schema.tournaments);
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
 * the database: sorted (see byPlayerId) and with an EXPLICIT entryType,
 * since tournament_entries.entry_type is NOT NULL DEFAULT 'da' — a
 * plain `{ playerId, seed }` entrant reads back as a direct acceptance
 * rather than with the field absent. A real, disclosed round-trip
 * detail, not a normalization that hides a difference. */
function persistedEntrants(entrants: ReadonlyArray<TournamentEntrant>): TournamentEntrant[] {
  return [...entrants].sort(byPlayerId).map((entrant) => ({ ...entrant, entryType: entryTypeOf(entrant) }));
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
