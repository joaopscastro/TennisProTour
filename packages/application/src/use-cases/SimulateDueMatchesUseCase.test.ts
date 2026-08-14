import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  GameWeek,
  GameWorld,
  ManagerId,
  PeakRankingEntry,
  RankingBand,
  RankingLedgerEntry,
  MatchId,
  MatchLog,
  MatchParticipant,
  MatchSimulator,
  Player,
  PlayerAttributes,
  PlayerId,
  SimulatedMatch,
  Skill,
  StandardManagerXpPolicy,
  StandardPlayerDevelopmentPolicy,
  StandardRankingPointsTable,
  Surface,
  SurfaceAffinities,
  TitleRecord,
  Tournament,
  TournamentId,
  StandardTournamentSchedulePolicy,
  WorldId,
} from '@tennis-manager/domain';
import {
  EventPublisherPort,
  GameWorldRepository,
  ManagerXpRepository,
  ManagerLadderRepository,
  ManagerLadderStanding,
  PeakRankingRepository,
  RankingLedgerRepository,
  MatchLogStorePort,
  PlayerRepository,
  TitleRepository,
  TournamentRepository,
} from '../ports/ports';
import { StandardManagerLadderPolicy } from '@tennis-manager/domain';
import { SimulateMatchUseCase } from './SimulateMatchUseCase';
import { SimulateDueMatchesUseCase } from './SimulateDueMatchesUseCase';

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

  async findByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [...this.store.values()].filter(
      (t) =>
        t.weekScheduled.season === week.season &&
        t.weekScheduled.week === week.week &&
        t.entrants.some((e) => e.playerId === playerId),
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

class CountingMatchLogStore implements MatchLogStorePort {
  saveCount = 0;

  async save(matchId: MatchId, _log: MatchLog): Promise<{ url: string }> {
    this.saveCount += 1;
    return { url: `https://replays.test/${matchId}` };
  }
}

class NullEventPublisher implements EventPublisherPort {
  async publish(): Promise<void> {}
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

class InMemoryManagerXpRepository implements ManagerXpRepository {
  private readonly balances = new Map<ManagerId, number>();

  async balanceFor(managerId: ManagerId): Promise<number> {
    return this.balances.get(managerId) ?? 0;
  }

  async credit(managerId: ManagerId, amount: number): Promise<void> {
    this.balances.set(managerId, (this.balances.get(managerId) ?? 0) + amount);
  }

  async spendXpIfSufficient(managerId: ManagerId, amount: number): Promise<boolean> {
    const balance = this.balances.get(managerId) ?? 0;
    if (balance < amount) return false;
    this.balances.set(managerId, balance - amount);
    return true;
  }
}

class InMemoryManagerLadderRepository implements ManagerLadderRepository {
  readonly scores = new Map<ManagerId, number>();
  async scoreFor(managerId: ManagerId): Promise<number> {
    return this.scores.get(managerId) ?? 0;
  }
  async credit(managerId: ManagerId, amount: number): Promise<void> {
    if (amount <= 0) return;
    this.scores.set(managerId, (this.scores.get(managerId) ?? 0) + amount);
  }
  async decayAll(factor: number): Promise<void> {
    for (const [id, score] of this.scores) this.scores.set(id, score * factor);
  }
  async topStandings(limit: number): Promise<ManagerLadderStanding[]> {
    return [...this.scores.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([managerId, score]) => ({ managerId, score }));
  }
  async rankFor(managerId: ManagerId): Promise<number | null> {
    const score = this.scores.get(managerId) ?? 0;
    if (score <= 0) return null;
    let higher = 0;
    for (const [, s] of this.scores) if (s > score) higher++;
    return higher + 1;
  }
}

class InMemoryPeakRankingRepository implements PeakRankingRepository {
  private readonly store = new Map<string, PeakRankingEntry>();
  private key(playerId: PlayerId, band: RankingBand): string {
    return `${playerId}:${band}`;
  }
  async findOne(playerId: PlayerId, band: RankingBand): Promise<PeakRankingEntry | null> {
    return this.store.get(this.key(playerId, band)) ?? null;
  }
  async upsert(entry: PeakRankingEntry): Promise<void> {
    this.store.set(this.key(entry.playerId, entry.band), entry);
  }
  async findAllForPlayer(playerId: PlayerId): Promise<PeakRankingEntry[]> {
    return [...this.store.values()].filter((e) => e.playerId === playerId);
  }
}

class InMemoryTitleRepository implements TitleRepository {
  private readonly titles: TitleRecord[] = [];
  async append(title: TitleRecord): Promise<void> {
    this.titles.push(title);
  }
  async findByPlayer(playerId: PlayerId): Promise<TitleRecord[]> {
    return this.titles.filter((t) => t.playerId === playerId);
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

const testWorldId = WorldId('test-world');

class AlwaysAWinsSimulator implements MatchSimulator {
  simulate<S extends string>(playerA: MatchParticipant<S>, playerB: MatchParticipant<S>, _surface: Surface): SimulatedMatch<S> {
    return {
      outcome: { winner: playerA.playerId, loser: playerB.playerId, setScores: [{ winnerGames: 6, loserGames: 0 }] },
      log: { entries: [], points: [], totalDurationSeconds: 0 },
    };
  }
}

function startingAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(30), forehand: Skill.of(30), backhand: Skill.of(30), volley: Skill.of(30) },
    physical: { speed: Skill.of(30), stamina: Skill.of(30), strength: Skill.of(30) },
    mental: { consistency: Skill.of(30), clutch: Skill.of(30) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

async function setup(worldWeek: GameWeek = { season: 1, week: 10 }, worldDay = 1) {
  const tournaments = new InMemoryTournamentRepository();
  const players = new InMemoryPlayerRepository();
  const matchLogs = new CountingMatchLogStore();

  for (let i = 1; i <= 16; i++) {
    await players.save(Player.hire(PlayerId(`p${i}`), `Player ${i}`, 20 * 52, startingAttributes(), ManagerId('m1')));
  }

  const bracketGenerator = new BracketGenerator();
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: testWorldId, currentWeek: worldWeek, currentDay: worldDay, lastAppliedTick: null }));
  const tournament = Tournament.open({ name: 'Test Tournament',
    id: TournamentId('t1'),
    tier: 'challenger',
    surface: 'hard',
    weekScheduled: { season: 1, week: 1 },
    drawSize: 16,
  });
  for (let i = 1; i <= 16; i++) {
    tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
  }
  tournament.startWithBracket(bracketGenerator.generate(tournament.entrants, 16));
  await tournaments.save(tournament);

  const simulateMatch = new SimulateMatchUseCase(
    tournaments,
    players,
    new AlwaysAWinsSimulator(),
    matchLogs,
    new NullEventPublisher(),
    bracketGenerator,
    new StandardRankingPointsTable(),
    new InMemoryRankingLedgerRepository(),
    new StandardManagerXpPolicy(),
    new InMemoryManagerXpRepository(),
    new StandardManagerLadderPolicy(),
    new InMemoryManagerLadderRepository(),
    new InMemoryPeakRankingRepository(),
    new InMemoryTitleRepository(),
    worlds,
    testWorldId,
    new StandardPlayerDevelopmentPolicy(),
  );
  const useCase = new SimulateDueMatchesUseCase(tournaments, simulateMatch, worlds, new StandardTournamentSchedulePolicy());

  return { tournaments, matchLogs, useCase, worlds };
}

describe('SimulateDueMatchesUseCase', () => {
  it('simulates every due match in the current round and nothing in future rounds', async () => {
    const { tournaments, useCase } = await setup();

    const result = await useCase.execute({ worldId: testWorldId });

    expect(result.simulated).toHaveLength(8); // all of round 1
    expect(result.failed).toHaveLength(0);
    const saved = await tournaments.findById(TournamentId('t1'));
    expect(saved!.isRoundComplete(1)).toBe(true);
    // Round 2 was generated by the last simulation but not played yet.
    expect(saved!.getRounds()).toHaveLength(2);
    expect(saved!.getRounds()[1].matches.every((m) => m.outcome === null)).toBe(true);
  });

  it('is idempotent for decided matches: a rerun only plays the newly-generated round, never re-simulates', async () => {
    const { matchLogs, useCase } = await setup();

    const first = await useCase.execute({ worldId: testWorldId });
    expect(first.simulated).toHaveLength(8);

    // Second run: round 1 is fully decided (guarded out); only round
    // 2's four fresh matches are due.
    const second = await useCase.execute({ worldId: testWorldId });
    expect(second.simulated).toHaveLength(4);
    expect(second.simulated.every((id) => id.includes('-r2-'))).toBe(true);
    expect(second.failed).toHaveLength(0);
    expect(matchLogs.saveCount).toBe(12); // 8 + 4, no duplicates
  });

  it('paces one round per day: a future round is not simulated until its scheduled day arrives', async () => {
    // World sits at the tournament's own week, day 1 — so only round 1
    // (scheduled day 1) is due. Round 2 is scheduled for day 2 and must
    // NOT be simulated until the clock actually reaches it, even though
    // its matches already exist after round 1 completes.
    const { tournaments, useCase, worlds } = await setup({ season: 1, week: 1 }, 1);

    const day1 = await useCase.execute({ worldId: testWorldId });
    expect(day1.simulated).toHaveLength(8); // round 1 only

    // Still day 1: round 2 exists but is not due yet — nothing plays.
    const stillDay1 = await useCase.execute({ worldId: testWorldId });
    expect(stillDay1.simulated).toHaveLength(0);
    const midweek = await tournaments.findById(TournamentId('t1'));
    expect(midweek!.getRounds()[1].matches.every((m) => m.outcome === null)).toBe(true);

    // Advance the clock to day 2 — now round 2 is due.
    const world = await worlds.findById(testWorldId);
    world!.advanceDay('pace-test-day-2');
    await worlds.save(world!);

    const day2 = await useCase.execute({ worldId: testWorldId });
    expect(day2.simulated).toHaveLength(4); // round 2
    expect(day2.simulated.every((id) => id.includes('-r2-'))).toBe(true);
  });

  it('does nothing at all once the tournament is complete', async () => {
    const { useCase } = await setup();

    // 8 + 4 + 2 + 1 = play the whole bracket down to the final.
    await useCase.execute({ worldId: testWorldId });
    await useCase.execute({ worldId: testWorldId });
    await useCase.execute({ worldId: testWorldId });
    const final = await useCase.execute({ worldId: testWorldId });
    expect(final.simulated).toHaveLength(1);

    const afterComplete = await useCase.execute({ worldId: testWorldId });
    expect(afterComplete.simulated).toHaveLength(0);
    expect(afterComplete.failed).toHaveLength(0);
  });
});
