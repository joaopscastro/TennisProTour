import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { ManagerId, PlayerId, TournamentId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import {
  PlayerAttributes,
  Skill,
  SurfaceAffinities,
} from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import * as schema from '../../db/schema';
import { DrizzlePlayerRepository } from './DrizzlePlayerRepository';
import { DrizzleTournamentRepository } from './DrizzleTournamentRepository';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';

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
  // Child tables first (FKs), then parents. ranking_ledger has FKs to
  // both players and tournaments, so it has to go before either.
  await db.delete(schema.rankingLedger);
  await db.delete(schema.tournamentMatches);
  await db.delete(schema.tournamentEntries);
  await db.delete(schema.tournaments);
  await db.delete(schema.players);
});

afterAll(async () => {
  await pool.end();
});

describe('DrizzlePlayerRepository', () => {
  const repository = new DrizzlePlayerRepository(db);

  it('round-trips a player through save and findById', async () => {
    const managerId = ManagerId('m1');
    const original = Player.hire(PlayerId('p1'), 'João Silva', 19 * 52, attributes(30), managerId, 'BR');
    original.applyMatchFatigue(12);
    original.setTrainingFocus({ kind: 'surface', surface: 'grass' });
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
    expect(loaded!.currentFocus).toEqual({ kind: 'surface', surface: 'grass' });
    expect(loaded!.attributes.technical.serve.value).toBe(30);
    expect(loaded!.attributes.technical.volley.value).toBe(33);
    expect(loaded!.attributes.physical.stamina.value).toBe(35);
    expect(loaded!.attributes.mental.clutch.value).toBe(38);
    expect(loaded!.attributes.surfaceAffinities.get('clay')).toBe(35);
    expect(loaded!.attributes.surfaceAffinities.get('grass')).toBe(20);
    // Reconstitution must not re-emit lifecycle events.
    expect(loaded!.pullDomainEvents()).toHaveLength(0);
  });

  it('round-trips a skill-cluster training focus and a null focus', async () => {
    const player = Player.hire(PlayerId('p-focus'), 'Focus Test', 19 * 52, attributes(30), ManagerId('m1'));
    player.setTrainingFocus({ kind: 'skill', cluster: 'mental' });
    await repository.save(player);
    expect((await repository.findById(PlayerId('p-focus')))!.currentFocus).toEqual({ kind: 'skill', cluster: 'mental' });

    player.setTrainingFocus(null);
    await repository.save(player);
    expect((await repository.findById(PlayerId('p-focus')))!.currentFocus).toBeNull();
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

    const original = Tournament.open({
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
    expect(loaded!.entrants).toEqual(original.entrants);
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

  it('round-trips an unstarted tournament and lists it via findOpenForRegistration', async () => {
    await savePlayers(10);

    const original = Tournament.open({
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
    expect(open[0].entrants).toEqual(original.entrants);
    expect(open[0].getRounds()).toHaveLength(0);

    // Saving again after it starts flips it out of the open list.
    original.startWithBracket(new BracketGenerator().generate(original.entrants, 16));
    await tournamentRepository.save(original);
    expect(await tournamentRepository.findOpenForRegistration()).toHaveLength(0);
  });
});
