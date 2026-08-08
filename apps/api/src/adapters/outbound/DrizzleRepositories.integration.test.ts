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
import { GeneratedPlayer, TalentPoolCandidate, TalentPoolCandidateId } from '@tennis-manager/domain';
import { Coach, CoachId } from '@tennis-manager/domain';
import * as schema from '../../db/schema';
import { DrizzlePlayerRepository } from './DrizzlePlayerRepository';
import { DrizzleTournamentRepository } from './DrizzleTournamentRepository';
import { DrizzleRankingLedgerRepository } from './DrizzleRankingLedgerRepository';
import { DrizzleTalentPoolCandidateRepository } from './DrizzleTalentPoolCandidateRepository';
import { DrizzleManagerXpRepository } from './DrizzleManagerXpRepository';
import { DrizzleTalentClaimAdapter } from './DrizzleTalentClaimAdapter';
import { DrizzleCoachRepository } from './DrizzleCoachRepository';

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
  await db.delete(schema.talentPoolCandidates); // no FKs, order doesn't matter
  await db.delete(schema.managerProgression); // no FKs, order doesn't matter
  await db.delete(schema.coaches); // no FKs, order doesn't matter
});

function generatedPlayer(overrides: Partial<GeneratedPlayer> = {}): GeneratedPlayer {
  return {
    name: 'Marta Silva',
    nationality: 'BR',
    tier: 'common',
    ageInWeeks: 750,
    attributes: attributes(30),
    potentialCeiling: 55,
    potentialTier: 'promising',
    physicalCeilings: { speed: 55, stamina: 55, strength: 55 },
    ...overrides,
  };
}

/** Round-trip tests compare entrant sets, not array order — the
 * domain never promises order is preserved (BracketGenerator seeds
 * off `seed`, never array position). */
function byPlayerId(a: { playerId: string }, b: { playerId: string }): number {
  return a.playerId.localeCompare(b.playerId);
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

  it('round-trips a single-attribute training focus and a null focus', async () => {
    const player = Player.hire(PlayerId('p-focus'), 'Focus Test', 19 * 52, attributes(30), ManagerId('m1'));
    player.setTrainingFocus({ kind: 'attribute', attribute: 'speed' });
    await repository.save(player);
    expect((await repository.findById(PlayerId('p-focus')))!.currentFocus).toEqual({ kind: 'attribute', attribute: 'speed' });

    player.setTrainingFocus(null);
    await repository.save(player);
    expect((await repository.findById(PlayerId('p-focus')))!.currentFocus).toBeNull();
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
    // Same set of entrants with the same seeds — not asserting on
    // array order, which the domain never promises is preserved
    // (BracketGenerator seeds off `seed`, never off array position;
    // see DrizzleTournamentRepository.load()'s doc comment on why
    // read order is deterministic but not necessarily insertion order).
    expect([...loaded!.entrants].sort(byPlayerId)).toEqual([...original.entrants].sort(byPlayerId));
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
    const junior = Tournament.open({
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

    const senior = Tournament.open({
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

    const sameWeek1 = Tournament.open({
      id: TournamentId('t-fpw-1'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'clay',
      weekScheduled: { season: 2, week: 8 },
      drawSize: 16,
    });
    sameWeek1.registerEntrant({ playerId: PlayerId('p1'), seed: null });
    await tournamentRepository.save(sameWeek1);

    const sameWeek2 = Tournament.open({
      id: TournamentId('t-fpw-2'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 2, week: 8 },
      drawSize: 16,
    });
    sameWeek2.registerEntrant({ playerId: PlayerId('p1'), seed: null });
    await tournamentRepository.save(sameWeek2);

    // Different week — must be excluded.
    const differentWeek = Tournament.open({
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
    const otherPlayerSameWeek = Tournament.open({
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
    // Same set of entrants, not asserting on array order — see the
    // other round-trip test's comment on why.
    expect([...open[0].entrants].sort(byPlayerId)).toEqual([...original.entrants].sort(byPlayerId));
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

    const juniorTournament = Tournament.open({
      id: TournamentId('t-junior-ledger'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'clay',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    await tournamentRepository.save(juniorTournament);

    const seniorTournament = Tournament.open({
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
});

describe('DrizzleTalentPoolCandidateRepository', () => {
  const repository = new DrizzleTalentPoolCandidateRepository(db);

  it('round-trips a generated candidate, including tier and attributes', async () => {
    const candidate = TalentPoolCandidate.generate(
      TalentPoolCandidateId('tp1'),
      generatedPlayer({ tier: 'exceptional' }),
      { season: 2, week: 7 },
    );
    await repository.save(candidate);

    const loaded = await repository.findById(TalentPoolCandidateId('tp1'));
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Marta Silva');
    expect(loaded!.nationality).toBe('BR');
    expect(loaded!.tier).toBe('exceptional');
    expect(loaded!.generatedAtWeek).toEqual({ season: 2, week: 7 });
    expect(loaded!.status).toBe('available');
    expect(loaded!.attributes.technical.serve.value).toBe(30);
    expect(loaded!.ageInWeeks).toBe(750);
    // Both the hidden real ceiling and the noisy displayed tier round-trip.
    expect(loaded!.potentialCeiling).toBe(55);
    expect(loaded!.potentialTier).toBe('promising');
    expect(loaded!.physicalCeilings).toEqual({ speed: 55, stamina: 55, strength: 55 });

    expect(await repository.findAvailable()).toHaveLength(1);
  });

  it('findAvailable excludes claimed and expired candidates', async () => {
    const available = TalentPoolCandidate.generate(TalentPoolCandidateId('tp1'), generatedPlayer(), { season: 1, week: 1 });
    const claimed = TalentPoolCandidate.generate(TalentPoolCandidateId('tp2'), generatedPlayer(), { season: 1, week: 1 });
    claimed.markClaimed(ManagerId('m1'));
    const expired = TalentPoolCandidate.generate(TalentPoolCandidateId('tp3'), generatedPlayer(), { season: 1, week: 1 });
    expired.markExpired();
    await Promise.all([repository.save(available), repository.save(claimed), repository.save(expired)]);

    const result = await repository.findAvailable();
    expect(result.map((c) => c.id)).toEqual(['tp1']);
  });

  it('claimIfAvailable atomically transitions an available candidate to claimed, and refuses a second claim', async () => {
    await repository.save(TalentPoolCandidate.generate(TalentPoolCandidateId('tp1'), generatedPlayer(), { season: 1, week: 1 }));

    const firstClaim = await repository.claimIfAvailable(TalentPoolCandidateId('tp1'), ManagerId('m1'));
    expect(firstClaim).not.toBeNull();
    expect(firstClaim!.status).toBe('claimed');
    expect(firstClaim!.claimedByManagerId).toBe(ManagerId('m1'));

    const secondClaim = await repository.claimIfAvailable(TalentPoolCandidateId('tp1'), ManagerId('m2'));
    expect(secondClaim).toBeNull();

    // The row itself still shows the FIRST manager as the claimant —
    // the second (failed) attempt didn't overwrite anything.
    const reloaded = await repository.findById(TalentPoolCandidateId('tp1'));
    expect(reloaded!.claimedByManagerId).toBe(ManagerId('m1'));
  });

  it('claimIfAvailable returns null for a candidate id that does not exist', async () => {
    const result = await repository.claimIfAvailable(TalentPoolCandidateId('does-not-exist'), ManagerId('m1'));
    expect(result).toBeNull();
  });

  it(
    'under real concurrent claim attempts against actual Postgres, exactly one of many simultaneous claims succeeds',
    async () => {
      await repository.save(TalentPoolCandidate.generate(TalentPoolCandidateId('tp1'), generatedPlayer(), { season: 1, week: 1 }));

      // 10 "managers" all fire claimIfAvailable at the same candidate
      // at once, via 10 genuinely separate connections from the pool —
      // this is the real thing the in-memory fake in
      // ClaimTalentPoolCandidateUseCase.test.ts can't actually prove:
      // that Postgres's own atomic conditional UPDATE (not JS's
      // single-threadedness) is what prevents a double claim.
      const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, i) => repository.claimIfAvailable(TalentPoolCandidateId('tp1'), ManagerId(`m${i}`))),
      );

      const successes = attempts.filter((result) => result !== null);
      expect(successes).toHaveLength(1);

      const reloaded = await repository.findById(TalentPoolCandidateId('tp1'));
      expect(reloaded!.status).toBe('claimed');
      expect(reloaded!.claimedByManagerId).toBe(successes[0]!.claimedByManagerId);
    },
  );
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
  const candidateRepository = new DrizzleTalentPoolCandidateRepository(db);
  const xpRepository = new DrizzleManagerXpRepository(db);

  it('claims the candidate and debits XP together when the manager can afford it', async () => {
    await candidateRepository.save(TalentPoolCandidate.generate(TalentPoolCandidateId('tp1'), generatedPlayer(), { season: 1, week: 1 }));
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(TalentPoolCandidateId('tp1'), ManagerId('m1'), 40);

    expect(outcome.kind).toBe('claimed');
    if (outcome.kind !== 'claimed') throw new Error('unreachable');
    expect(outcome.candidate.claimedByManagerId).toBe(ManagerId('m1'));
    expect(outcome.xpSpent).toBe(40);
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(60);

    const reloaded = await candidateRepository.findById(TalentPoolCandidateId('tp1'));
    expect(reloaded!.status).toBe('claimed');
  });

  it('refuses and spends nothing when the manager cannot afford the candidate', async () => {
    await candidateRepository.save(TalentPoolCandidate.generate(TalentPoolCandidateId('tp1'), generatedPlayer(), { season: 1, week: 1 }));
    await xpRepository.credit(ManagerId('m1'), 10);

    const outcome = await adapter.claimAndCharge(TalentPoolCandidateId('tp1'), ManagerId('m1'), 40);

    expect(outcome).toEqual({ kind: 'insufficient-xp', required: 40, balance: 10 });
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(10);

    // The candidate is untouched — still available for someone who CAN afford it.
    const reloaded = await candidateRepository.findById(TalentPoolCandidateId('tp1'));
    expect(reloaded!.status).toBe('available');
  });

  it('refuses when the candidate is already claimed, rolling back the XP debit (no partial spend)', async () => {
    const candidate = TalentPoolCandidate.generate(TalentPoolCandidateId('tp1'), generatedPlayer(), { season: 1, week: 1 });
    candidate.markClaimed(ManagerId('someone-else'));
    await candidateRepository.save(candidate);
    await xpRepository.credit(ManagerId('m1'), 100);

    const outcome = await adapter.claimAndCharge(TalentPoolCandidateId('tp1'), ManagerId('m1'), 40);

    expect(outcome).toEqual({ kind: 'candidate-unavailable' });
    // The XP debit that happened INSIDE the transaction was rolled back
    // along with everything else — this is the whole point of using a
    // real transaction instead of two independent conditional UPDATEs.
    expect(await xpRepository.balanceFor(ManagerId('m1'))).toBe(100);
  });

  it(
    'under real concurrent claims for TWO DIFFERENT candidates that together exceed the balance, exactly one succeeds',
    async () => {
      // Isolates the cross-table XP race specifically (independent of
      // the single-candidate claim race, which claimIfAvailable's own
      // concurrency test above already covers): two distinct available
      // candidates, each costing 60, against a shared balance of 100 —
      // only one of the two claims can possibly be affordable, and this
      // must hold under genuinely concurrent Postgres transactions, not
      // just JS's single-threadedness.
      await candidateRepository.save(TalentPoolCandidate.generate(TalentPoolCandidateId('tp1'), generatedPlayer(), { season: 1, week: 1 }));
      await candidateRepository.save(TalentPoolCandidate.generate(TalentPoolCandidateId('tp2'), generatedPlayer(), { season: 1, week: 1 }));
      await xpRepository.credit(ManagerId('m1'), 100);

      const [outcomeA, outcomeB] = await Promise.all([
        adapter.claimAndCharge(TalentPoolCandidateId('tp1'), ManagerId('m1'), 60),
        adapter.claimAndCharge(TalentPoolCandidateId('tp2'), ManagerId('m1'), 60),
      ]);

      const successes = [outcomeA, outcomeB].filter((o) => o.kind === 'claimed');
      expect(successes).toHaveLength(1);

      const finalBalance = await xpRepository.balanceFor(ManagerId('m1'));
      expect(finalBalance).toBe(40); // exactly one 60-cost claim went through
      expect(finalBalance).toBeGreaterThanOrEqual(0); // never went negative
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
