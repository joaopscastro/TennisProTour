import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  DoublesPair,
  DoublesPairingService,
  GameWeek,
  GameWorld,
  ManagerId,
  PairId,
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
import { DoublesPairRepository, GameWorldRepository, PlayerRepository, RankingLedgerRepository, TournamentRepository } from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { FormDoublesDrawUseCase } from './FormDoublesDrawUseCase';

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

  async findDoublesByPlayerAndWeek(): Promise<Tournament[]> {
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
}

class InMemoryDoublesPairRepository implements DoublesPairRepository {
  private readonly store = new Map<PairId, DoublesPair>();

  async findById(id: PairId): Promise<DoublesPair | null> {
    return this.store.get(id) ?? null;
  }

  async findByPlayer(playerId: PlayerId): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => p.playerA === playerId || p.playerB === playerId);
  }

  async findByPlayers(playerIds: PlayerId[]): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => playerIds.includes(p.playerA) || playerIds.includes(p.playerB));
  }

  async findActive(): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => p.isActive);
  }

  async save(pair: DoublesPair): Promise<void> {
    this.store.set(pair.id, pair);
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

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
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

function fillOnlyPlayer(id: string, ageInWeeks = 25 * 52): Player {
  return Player.generateFillOnly(PlayerId(id), `Filler ${id}`, ageInWeeks, 'prime', attributes(30), 'BR', 55, physicalCeilings);
}

const worldId = WorldId('main');

async function setup(currentWeek: GameWeek) {
  const tournaments = new InMemoryTournamentRepository();
  const players = new InMemoryPlayerRepository();
  const pairs = new InMemoryDoublesPairRepository();
  const rankingLedger = new InMemoryRankingLedgerRepository();
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek, lastAppliedTick: null }));
  const rankByBand: Record<RankingBand, RankPositionQuery> = {
    senior: new RankPositionQuery(rankingLedger, worlds, worldId, 'senior'),
    u14: new RankPositionQuery(rankingLedger, worlds, worldId, 'u14'),
    u16: new RankPositionQuery(rankingLedger, worlds, worldId, 'u16'),
  };
  const bracketGenerator = new BracketGenerator();
  const useCase = new FormDoublesDrawUseCase(
    tournaments,
    players,
    pairs,
    rankByBand,
    rankByBand,
    new DoublesPairingService(),
    bracketGenerator,
    { next: () => 0.5 },
  );
  return { tournaments, players, pairs, useCase };
}

function doublesTournament(id: string, weekScheduled: GameWeek = { season: 1, week: 4 }): Tournament {
  return Tournament.open({
    name: 'Test Doubles Tournament',
    id: TournamentId(id),
    tier: 'challenger',
    surface: 'clay',
    weekScheduled,
    drawSize: 16,
    doublesDrawSize: 8,
  });
}

describe('FormDoublesDrawUseCase', () => {
  it('forms a real bracket for a lone persistent pair by padding the field from free agents, instead of silently no-oping', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const tournament = doublesTournament('t-lone-pair');
    const a = fillOnlyPlayer('a');
    const b = fillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);

    for (let i = 1; i <= 20; i++) {
      await players.save(fillOnlyPlayer(`filler-${i}`));
    }

    await useCase.form(tournament);
    await tournaments.save(tournament);

    const formed = await tournaments.findById(TournamentId('t-lone-pair'));
    expect(formed!.hasDoublesDrawStarted).toBe(true);
    expect(formed!.doublesPairs.length).toBeGreaterThanOrEqual(2);
    const pairIncludingAB = formed!.doublesPairs.find((p) => (p.playerA === a.id && p.playerB === b.id) || (p.playerA === b.id && p.playerB === a.id));
    expect(pairIncludingAB).toBeDefined();
  });

  it('never double-books a filler already committed to another tournament the same week', async () => {
    const { tournaments, players, pairs, useCase } = await setup({ season: 1, week: 4 });

    const otherSingles = Tournament.open({
      name: 'Other Singles',
      id: TournamentId('t-other-singles'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 4 },
      drawSize: 16,
    });
    otherSingles.registerEntrant({ playerId: PlayerId('filler-committed'), seed: null });
    await tournaments.save(otherSingles);

    const tournament = doublesTournament('t-needs-fill');
    const a = fillOnlyPlayer('a');
    const b = fillOnlyPlayer('b');
    tournament.registerDoublesEntrant(a.id);
    tournament.registerDoublesEntrant(b.id);
    await players.save(a);
    await players.save(b);
    await pairs.save(DoublesPair.activate(PairId('pp-ab'), a.id, b.id));
    await tournaments.save(tournament);

    await players.save(fillOnlyPlayer('filler-committed'));

    await useCase.form(tournament);
    await tournaments.save(tournament);

    const formed = await tournaments.findById(TournamentId('t-needs-fill'));
    // With no other free agent available, the field can't be padded past
    // the 2 real entrants, so no bracket forms — but critically, the
    // committed filler must never appear in it.
    const usedIds = formed!.doublesPairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(usedIds).not.toContain(PlayerId('filler-committed'));
  });

  it('is a no-op for a tournament with no doubles draw at all', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 4 });

    const tournament = Tournament.open({
      name: 'Singles Only',
      id: TournamentId('t-singles-only'),
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 4 },
      drawSize: 16,
    });
    await tournaments.save(tournament);

    await useCase.form(tournament);

    expect(tournament.hasDoublesDrawStarted).toBe(false);
  });
});
