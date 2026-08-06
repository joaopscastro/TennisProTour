import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  ManagerId,
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
  StandardRankingPointsTable,
  Surface,
  SurfaceAffinities,
  Tournament,
  TournamentId,
} from '@tennis-manager/domain';
import {
  EventPublisherPort,
  ManagerXpRepository,
  RankingLedgerRepository,
  MatchLogStorePort,
  PlayerRepository,
  TournamentRepository,
} from '../ports/ports';
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

class AlwaysAWinsSimulator implements MatchSimulator {
  simulate(playerA: MatchParticipant, playerB: MatchParticipant, _surface: Surface): SimulatedMatch {
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

async function setup() {
  const tournaments = new InMemoryTournamentRepository();
  const players = new InMemoryPlayerRepository();
  const matchLogs = new CountingMatchLogStore();

  for (let i = 1; i <= 16; i++) {
    await players.save(Player.hire(PlayerId(`p${i}`), `Player ${i}`, 20 * 52, startingAttributes(), ManagerId('m1')));
  }

  const bracketGenerator = new BracketGenerator();
  const tournament = Tournament.open({
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
  );
  const useCase = new SimulateDueMatchesUseCase(tournaments, simulateMatch);

  return { tournaments, matchLogs, useCase };
}

describe('SimulateDueMatchesUseCase', () => {
  it('simulates every due match in the current round and nothing in future rounds', async () => {
    const { tournaments, useCase } = await setup();

    const result = await useCase.execute();

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

    const first = await useCase.execute();
    expect(first.simulated).toHaveLength(8);

    // Second run: round 1 is fully decided (guarded out); only round
    // 2's four fresh matches are due.
    const second = await useCase.execute();
    expect(second.simulated).toHaveLength(4);
    expect(second.simulated.every((id) => id.includes('-r2-'))).toBe(true);
    expect(second.failed).toHaveLength(0);
    expect(matchLogs.saveCount).toBe(12); // 8 + 4, no duplicates
  });

  it('does nothing at all once the tournament is complete', async () => {
    const { useCase } = await setup();

    // 8 + 4 + 2 + 1 = play the whole bracket down to the final.
    await useCase.execute();
    await useCase.execute();
    await useCase.execute();
    const final = await useCase.execute();
    expect(final.simulated).toHaveLength(1);

    const afterComplete = await useCase.execute();
    expect(afterComplete.simulated).toHaveLength(0);
    expect(afterComplete.failed).toHaveLength(0);
  });
});
