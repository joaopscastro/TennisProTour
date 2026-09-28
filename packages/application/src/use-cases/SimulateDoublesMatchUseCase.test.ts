import { describe, expect, it } from 'vitest';
import {
  BracketGenerator,
  DoublesPair,
  DoublesPeakRankingEntry,
  DoublesTitleRecord,
  GameWeek,
  GameWorld,
  ManagerId,
  MatchId,
  MatchLog,
  MatchParticipant,
  MatchSimulator,
  PairId,
  Player,
  PlayerAttributes,
  PlayerId,
  RankingBand,
  RankingLedgerEntry,
  SimulatedMatch,
  Skill,
  StandardDoublesPairPolicy,
  StandardManagerLadderPolicy,
  StandardManagerXpPolicy,
  StandardPlayerDevelopmentPolicy,
  StandardRankingPointsTable,
  Surface,
  SurfaceAffinities,
  Tournament,
  TournamentId,
  WorldId,
} from '@tennis-manager/domain';
import {
  DoublesPairRepository,
  DoublesPeakRankingRepository,
  DoublesTitleRepository,
  EventPublisherPort,
  GameWorldRepository,
  ManagerLadderRepository,
  ManagerLadderStanding,
  ManagerXpRepository,
  MatchLogStorePort,
  PlayerRepository,
  RankingLedgerRepository,
  TournamentRepository,
} from '../ports/ports';
import { SimulateDoublesMatchUseCase } from './SimulateDoublesMatchUseCase';

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
  async findByPlayerAndWeek(): Promise<Tournament[]> {
    return [];
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

class FakeMatchLogStore implements MatchLogStorePort {
  async save(matchId: MatchId, _log: MatchLog): Promise<{ url: string }> {
    return { url: `https://replays.test/${matchId}` };
  }
  async read(): Promise<string> {
    throw new Error('not used');
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  async publish(): Promise<void> {}
}

class InMemoryRankingLedgerRepository implements RankingLedgerRepository {
  readonly entries: RankingLedgerEntry[] = [];
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
  async spendXpIfSufficient(): Promise<boolean> {
    return true;
  }
}

class InMemoryManagerLadderRepository implements ManagerLadderRepository {
  private readonly scores = new Map<ManagerId, number>();
  async scoreFor(managerId: ManagerId): Promise<number> {
    return this.scores.get(managerId) ?? 0;
  }
  async credit(managerId: ManagerId, amount: number): Promise<void> {
    this.scores.set(managerId, (this.scores.get(managerId) ?? 0) + amount);
  }
  async decayAll(): Promise<void> {}
  async decayManagers(): Promise<void> {}
  async topStandings(): Promise<ManagerLadderStanding[]> {
    return [];
  }
  async rankFor(): Promise<number | null> {
    return null;
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

class InMemoryDoublesTitleRepository implements DoublesTitleRepository {
  readonly titles: DoublesTitleRecord[] = [];
  async append(title: DoublesTitleRecord): Promise<void> {
    this.titles.push(title);
  }
  async findByPlayer(): Promise<DoublesTitleRecord[]> {
    return [];
  }
}

class InMemoryDoublesPeakRankingRepository implements DoublesPeakRankingRepository {
  private readonly store = new Map<string, DoublesPeakRankingEntry>();
  async findOne(playerId: PlayerId, band: RankingBand): Promise<DoublesPeakRankingEntry | null> {
    return this.store.get(`${playerId}:${band}`) ?? null;
  }
  async upsert(entry: DoublesPeakRankingEntry): Promise<void> {
    this.store.set(`${entry.playerId}:${entry.band}`, entry);
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

/** Always declares the requested SLOT the winner — the only way to pin
 * "side A wins" vs "side B wins" deterministically. Note that the use
 * case under test must award the ledger to whichever side this picks,
 * regardless of which slot the bracket happened to place it in. */
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

function attributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

const worldId = WorldId('doubles-fix-world');

function makePlayer(id: string): Player {
  const player = Player.hire(PlayerId(id), id, 22 * 52, attributes(50), ManagerId('m1'));
  player.pullDomainEvents();
  return player;
}

/**
 * A started doubles tournament with a full 8-pair / 8-draw bracket, so
 * round 1 has real matches (a 4-draw with 4 pairs would still have
 * matches, but 8 is the shape production uses).
 *
 * Returns the scheduled round-1 match-0 slot ids as well, since which
 * PAIR the bracket places in the entrantA slot is the generator's
 * business — the assertions must read the actual slot arrangement, not
 * assume one.
 */
function setupStartedDoubles(): {
  tournaments: InMemoryTournamentRepository;
  players: InMemoryPlayerRepository;
  ledger: InMemoryRankingLedgerRepository;
  tournament: Tournament;
  entrantA: PairId;
  entrantB: PairId;
} {
  const tournaments = new InMemoryTournamentRepository();
  const players = new InMemoryPlayerRepository();

  const tournament = Tournament.open({
    name: 'Doubles Award Test',
    id: TournamentId('td-award'),
    tier: 'challenger',
    surface: 'hard',
    weekScheduled: { season: 1, week: 1 },
    drawSize: 16,
    doublesDrawSize: 8,
  });

  const pairIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const pairs = pairIds.map((key) => ({
    pairId: PairId(`pair-${key}`),
    playerA: PlayerId(`${key}1`),
    playerB: PlayerId(`${key}2`),
    chemistry: 0,
  }));
  for (const pair of pairs) {
    for (const playerId of [pair.playerA, pair.playerB]) {
      void players.save(makePlayer(playerId));
    }
  }
  const generator = new BracketGenerator();
  tournament.startDoublesWithBracket(
    pairs,
    generator.generate(pairs.map((p) => ({ playerId: p.pairId, seed: null })), 8),
  );
  tournament.pullDomainEvents();
  void tournaments.save(tournament);

  const scheduled = tournament.getDoublesScheduledMatch(1, 0);
  return { tournaments, players, ledger: new InMemoryRankingLedgerRepository(), tournament, entrantA: scheduled.entrantA, entrantB: scheduled.entrantB };
}

function makeUseCase(
  tournaments: InMemoryTournamentRepository,
  players: InMemoryPlayerRepository,
  ledger: InMemoryRankingLedgerRepository,
  winningSide: 'A' | 'B',
): SimulateDoublesMatchUseCase {
  const worlds = new InMemoryGameWorldRepository();
  void worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
  return new SimulateDoublesMatchUseCase(
    tournaments,
    players,
    new FixedSlotWinnerSimulator(winningSide),
    new StandardDoublesPairPolicy(),
    new FakeMatchLogStore(),
    new RecordingEventPublisher(),
    new BracketGenerator(),
    new StandardRankingPointsTable(),
    ledger,
    new StandardManagerXpPolicy(),
    new InMemoryManagerXpRepository(),
    new StandardManagerLadderPolicy(),
    new InMemoryManagerLadderRepository(),
    worlds,
    worldId,
    new StandardPlayerDevelopmentPolicy(),
    new InMemoryDoublesPairRepository(),
    new InMemoryDoublesTitleRepository(),
    new InMemoryDoublesPeakRankingRepository(),
  );
}

/** The ledger rows for one side's two players, restricted to the
 * doubles discipline (the singles ledger is untouched by this use case). */
function doublesPointsFor(ledger: InMemoryRankingLedgerRepository, playerId: PlayerId): number | null {
  const rows = ledger.entries.filter((e) => e.playerId === playerId && (e.discipline ?? 'singles') === 'doubles');
  return rows.length === 0 ? null : rows[rows.length - 1].points;
}

describe('SimulateDoublesMatchUseCase — doubles points land on the side that actually won', () => {
  it('orientation A: the entrantA-slot pair wins and receives the winner value; the other side gets 0', async () => {
    const { tournaments, players, ledger, tournament, entrantA, entrantB } = setupStartedDoubles();
    const useCase = makeUseCase(tournaments, players, ledger, 'A');

    await useCase.execute({ matchId: MatchId('td-award-doubles-r1-m0'), tournamentId: tournament.id, roundNumber: 1, matchIndex: 0 });

    const winningPair = tournament.doublesPlayersFor(entrantA)!;
    const losingPair = tournament.doublesPlayersFor(entrantB)!;
    // The winner advanced a round (value > 0); the loser earned nothing.
    expect(doublesPointsFor(ledger, winningPair.playerA)).toBeGreaterThan(0);
    expect(doublesPointsFor(ledger, winningPair.playerB)).toBeGreaterThan(0);
    expect(doublesPointsFor(ledger, losingPair.playerA)).toBe(0);
    expect(doublesPointsFor(ledger, losingPair.playerB)).toBe(0);
  });

  it('orientation B: the entrantB-slot pair wins — its players receive the winner value, NOT the entrantA-slot pair', async () => {
    const { tournaments, players, ledger, tournament, entrantA, entrantB } = setupStartedDoubles();
    const useCase = makeUseCase(tournaments, players, ledger, 'B');

    await useCase.execute({ matchId: MatchId('td-award-doubles-r1-m0'), tournamentId: tournament.id, roundNumber: 1, matchIndex: 0 });

    const slotPairA = tournament.doublesPlayersFor(entrantA)!;
    const slotPairB = tournament.doublesPlayersFor(entrantB)!;
    // This is the exact case the old slot-based award got wrong: the
    // winner is in the entrantB SLOT, so a slot-based implementation
    // would hand the winner value to slot A's pair and zero to slot B's.
    expect(doublesPointsFor(ledger, slotPairB.playerA)).toBeGreaterThan(0);
    expect(doublesPointsFor(ledger, slotPairB.playerB)).toBeGreaterThan(0);
    expect(doublesPointsFor(ledger, slotPairA.playerA)).toBe(0);
    expect(doublesPointsFor(ledger, slotPairA.playerB)).toBe(0);
  });
});
