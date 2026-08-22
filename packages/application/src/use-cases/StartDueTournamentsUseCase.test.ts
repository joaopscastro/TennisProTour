import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  DrawSize,
  GameWeek,
  GameWorld,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  RankingBand,
  RankingLedgerEntry,
  Skill,
  SurfaceAffinities,
  Tournament,
  TournamentId,
  WorldId,
} from '@tennis-manager/domain';
import { GameWorldRepository, PlayerRepository, RankingLedgerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { StartDueTournamentsUseCase } from './StartDueTournamentsUseCase';

class InMemoryTournamentRepository implements TournamentRepository {
  private readonly store = new Map<TournamentId, Tournament>();

  async findById(id: TournamentId): Promise<Tournament | null> {
    return this.store.get(id) ?? null;
  }

  async findOpenForRegistration(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => !t.hasStarted);
  }

  async findStarted(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => t.hasStarted);
  }

  async findDoublesByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [];
  }

  async findByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [...this.store.values()].filter(
      (t) => t.weekScheduled.season === week.season && t.weekScheduled.week === week.week && t.entrants.some((e) => e.playerId === playerId),
    );
  }

  async save(tournament: Tournament): Promise<void> {
    this.store.set(tournament.id, tournament);
  }
}

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

class InMemoryPlayerRepository implements PlayerRepository {
  private readonly store = new Map<PlayerId, Player>();

  async findById(id: PlayerId): Promise<Player | null> {
    return this.store.get(id) ?? null;
  }

  async findByManager(managerId: ManagerId): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === managerId);
  }

  async findAll(): Promise<Player[]> {
    return [...this.store.values()];
  }

  async findFreeAgents(): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === null && !p.isRetired());
  }

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }

  all(): Player[] {
    return [...this.store.values()];
  }
}

class InMemoryRankingLedgerRepository implements RankingLedgerRepository {
  private readonly entries: RankingLedgerEntry[] = [];

  async append(entry: RankingLedgerEntry): Promise<void> {
    this.entries.push(entry);
  }

  async findByPlayer(playerId: PlayerId): Promise<RankingLedgerEntry[]> {
    return this.entries.filter((e) => e.playerId === playerId);
  }

  async findAll(): Promise<RankingLedgerEntry[]> {
    return [...this.entries];
  }
}

function attributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

const physicalCeilings = { speed: 55, stamina: 55, strength: 55 } as const;

function fillOnlyPlayer(id: string, ageInWeeks: number, stage: 'youth' | 'prime' | 'decline' = 'prime'): Player {
  return Player.generateFillOnly(PlayerId(id), `Filler ${id}`, ageInWeeks, stage, attributes(30), 'BR', 55, physicalCeilings);
}

const worldId = WorldId('main');

async function setup(currentWeek: GameWeek) {
  const tournaments = new InMemoryTournamentRepository();
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));
  const players = new InMemoryPlayerRepository();
  const rankingLedger = new InMemoryRankingLedgerRepository();
  const bracketGenerator = new BracketGenerator();
  const rankPositionByBand: Record<RankingBand, RankPositionQuery> = {
    senior: new RankPositionQuery(rankingLedger, worlds, worldId, 'senior'),
    u14: new RankPositionQuery(rankingLedger, worlds, worldId, 'u14'),
    u16: new RankPositionQuery(rankingLedger, worlds, worldId, 'u16'),
  };
  const useCase = new StartDueTournamentsUseCase(tournaments, worlds, players, bracketGenerator, rankPositionByBand);
  return { tournaments, worlds, players, rankingLedger, useCase };
}

function openSeniorTournament(id: string, drawSize: DrawSize = 16): Tournament {
  return Tournament.open({ name: 'Test Tournament', id: TournamentId(id), tier: 'challenger', surface: 'clay', weekScheduled: { season: 1, week: 1 }, drawSize });
}

function realEntrant(tournament: Tournament, playerId: string): void {
  tournament.registerEntrant({ playerId: PlayerId(playerId), seed: null });
}

describe('StartDueTournamentsUseCase', () => {
  it('fills a tournament with too few real registrants from fillOnly free agents, then starts it', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    const tournament = openSeniorTournament('t1');
    for (let i = 1; i <= 8; i++) realEntrant(tournament, `real-${i}`);
    await tournaments.save(tournament);

    await players.save(fillOnlyPlayer('filler-1', 25 * 52));
    await players.save(fillOnlyPlayer('filler-2', 22 * 52));

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(1);
    expect(result.filled).toBe(2);

    const started = await tournaments.findById(TournamentId('t1'));
    expect(started!.hasStarted).toBe(true);
    const entrantIds = started!.entrants.map((e) => e.playerId).sort();
    const expectedIds = ['filler-1', 'filler-2', 'real-1', 'real-2', 'real-3', 'real-4', 'real-5', 'real-6', 'real-7', 'real-8'].sort();
    expect(entrantIds).toEqual(expectedIds);
    expect((await players.findById(PlayerId('filler-1')))!.fillOnly).toBe(true);
  });

  it('a fully-registered tournament starts with exactly its real entrants and triggers no fill at all', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    const tournament = openSeniorTournament('t-full');
    for (let i = 1; i <= 16; i++) realEntrant(tournament, `real-${i}`);
    await tournaments.save(tournament);

    await players.save(fillOnlyPlayer('filler-1', 25 * 52));
    await players.save(fillOnlyPlayer('filler-2', 22 * 52));

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(1);
    expect(result.filled).toBe(0);

    const started = await tournaments.findById(TournamentId('t-full'));
    expect(started!.entrants).toHaveLength(16);
    expect(started!.entrants.every((e) => e.playerId.startsWith('real-'))).toBe(true);
    expect((await players.findById(PlayerId('filler-1')))!.managerId).toBeNull();
  });

  it('skips an unclaimed player already committed to another tournament the same week, picking a different eligible one instead', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    const otherTournament = openSeniorTournament('t-other');
    realEntrant(otherTournament, 'filler-1');
    for (let i = 1; i <= 15; i++) realEntrant(otherTournament, `other-${i}`);
    await tournaments.save(otherTournament);

    const tournament = openSeniorTournament('t-needs-one');
    for (let i = 1; i <= 15; i++) realEntrant(tournament, `real-${i}`);
    await tournaments.save(tournament);

    await players.save(fillOnlyPlayer('filler-1', 25 * 52));
    await players.save(fillOnlyPlayer('filler-2', 25 * 52));

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(2);
    expect(result.filled).toBe(1);

    const filled = await tournaments.findById(TournamentId('t-needs-one'));
    const entrantIds = filled!.entrants.map((e) => e.playerId);
    expect(entrantIds).toContain('filler-2');
    expect(entrantIds).not.toContain('filler-1');
  });

  it('excludes an age-band-ineligible fillOnly free agent from a junior tournament', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    const junior = Tournament.open({
      name: 'Test Tournament',
      id: TournamentId('t-u14'),
      tier: 'j100',
      ageBand: 'u14',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    realEntrant(junior, 'real-1');
    await tournaments.save(junior);

    await players.save(fillOnlyPlayer('filler-too-old', 25 * 52));
    await players.save(fillOnlyPlayer('filler-u14', 13 * 52 + 10, 'youth'));

    await useCase.execute({ worldId });

    const filled = await tournaments.findById(TournamentId('t-u14'));
    const entrantIds = filled!.entrants.map((e) => e.playerId);
    expect(entrantIds).toContain('filler-u14');
    expect(entrantIds).not.toContain('filler-too-old');
  });

  it('leaves a tournament open when it stays at zero entrants', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 4 });

    const tournament = openSeniorTournament('t-empty');
    await tournaments.save(tournament);

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(0);
    const stillOpen = await tournaments.findById(TournamentId('t-empty'));
    expect(stillOpen!.hasStarted).toBe(false);
  });

  it('leaves a tournament open when fill still leaves too sparse a field to produce a real round-1 match', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 4 });

    const tournament = openSeniorTournament('t-too-sparse');
    await tournaments.save(tournament);

    for (let i = 1; i <= 5; i++) {
      await players.save(fillOnlyPlayer(`filler-${i}`, 25 * 52));
    }

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(0);
    expect(result.filled).toBe(5);
    const stillOpen = await tournaments.findById(TournamentId('t-too-sparse'));
    expect(stillOpen!.hasStarted).toBe(false);
    expect(stillOpen!.entrants).toHaveLength(5);
  });

  it('does not touch a tournament whose scheduled week has not arrived yet', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 2 });

    const tournament = Tournament.open({
      name: 'Test Tournament',
      id: TournamentId('t-future'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 5 },
      drawSize: 16,
    });
    realEntrant(tournament, 'real-1');
    await tournaments.save(tournament);

    const result = await useCase.execute({ worldId });

    expect(result.started).toBe(0);
    expect((await tournaments.findById(TournamentId('t-future')))!.hasStarted).toBe(false);
  });

  it('DOES start a tournament scheduled for THIS exact week (generation now opens for next week)', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 3 });

    const tournament = Tournament.open({
      name: 'Test Tournament',
      id: TournamentId('t-this-week'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 3 },
      drawSize: 16,
    });
    for (let i = 1; i <= 10; i++) realEntrant(tournament, `real-${i}`);
    await tournaments.save(tournament);

    const result = await useCase.execute({ worldId });

    // Inclusive `weeksBetween >= 0`: a tournament whose week has ARRIVED
    // is due and starts now (playing during its own labeled week).
    expect(result.started).toBe(1);
    expect((await tournaments.findById(TournamentId('t-this-week')))!.hasStarted).toBe(true);
  });

  it('throws when the target game world does not exist', async () => {
    const { useCase } = await setup({ season: 1, week: 1 });

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});

describe('StartDueTournamentsUseCase — automatic wild cards', () => {
  /** A `tour`-tier tournament with real qualifying AND wild card slots
   * reserved, exactly like OpenRegistrationUseCase would open one —
   * mainDrawCapacity = 16 - 2 (qualifierSlots) - 2 (wildCardSlots) = 12. */
  function openTourTournamentWithWildCards(id: string, hostCountry: string | null): Tournament {
    return Tournament.open({
      name: 'Weekly Sweep Wild Card Test',
      id: TournamentId(id),
      tier: 'tour',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
      hostCountry,
      qualifyingDrawSize: 8,
      qualifierSlots: 2,
      wildCardSlots: 2,
    });
  }

  it('promotes REAL local qualifying registrants to wild cards before padding the field with fillers', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 1 });
    const tournament = openTourTournamentWithWildCards('t-weekly-wc', 'Brazil');
    tournament.registerEntrant({ playerId: PlayerId('br1'), seed: null, draw: 'qualifying', entryType: 'Q' });
    tournament.registerEntrant({ playerId: PlayerId('fr1'), seed: null, draw: 'qualifying', entryType: 'Q' });
    await tournaments.save(tournament);
    await players.save(Player.hire(PlayerId('br1'), 'BR One', 25 * 52, attributes(50), ManagerId('m1'), 'Brazil'));
    await players.save(Player.hire(PlayerId('fr1'), 'FR One', 25 * 52, attributes(50), ManagerId('m1'), 'France'));

    await useCase.execute({ worldId });

    const saved = await tournaments.findById(TournamentId('t-weekly-wc'));
    const wcEntrants = saved!.entrants.filter((e) => e.entryType === 'WC');
    expect(wcEntrants.map((e) => e.playerId)).toEqual([PlayerId('br1')]);
    expect(saved!.mainEntrants.map((e) => e.playerId)).toContain(PlayerId('br1'));
  });

  it('never grants a wild card to a filler used to pad the qualifying field — only to a real registrant', async () => {
    const { tournaments, players, useCase } = await setup({ season: 1, week: 1 });
    const tournament = openTourTournamentWithWildCards('t-weekly-wc-fillers', 'Brazil');
    // No real qualifying registrants at all — the whole 8-player field
    // will be padded entirely by fillOnly free agents.
    await tournaments.save(tournament);
    for (let i = 1; i <= 20; i++) {
      await players.save(fillOnlyPlayer(`filler-br-${i}`, 25 * 52));
    }

    await useCase.execute({ worldId });

    const saved = await tournaments.findById(TournamentId('t-weekly-wc-fillers'));
    expect(saved!.entrants.some((e) => e.entryType === 'WC')).toBe(false);
  });
});