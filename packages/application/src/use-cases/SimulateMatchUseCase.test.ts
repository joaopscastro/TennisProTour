import { describe, expect, it } from 'vitest';
import { GameWeek, GameWorld, ManagerId, MatchId, PeakRankingEntry, PlayerId, RankingBand, TitleRecord, TournamentId, RankingLedgerEntry, WorldId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { StandardPlayerDevelopmentPolicy } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { DrawSize, MatchLog, TournamentTier } from '@tennis-manager/domain';
import { MatchParticipant, MatchSimulator, SimulatedMatch } from '@tennis-manager/domain';
import { StandardManagerXpPolicy, StandardRankingPointsTable } from '@tennis-manager/domain';
import { StandardManagerLadderPolicy } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
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
import { MATCH_SURFACE_AFFINITY_GAIN, SimulateMatchUseCase } from './SimulateMatchUseCase';

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

class FakeMatchLogStore implements MatchLogStorePort {
  async save(matchId: MatchId, _log: MatchLog): Promise<{ url: string }> {
    return { url: `https://replays.test/${matchId}` };
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
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

  async decayManagers(managerIds: ManagerId[], factor: number): Promise<void> {
    for (const id of managerIds) {
      const score = this.scores.get(id);
      if (score !== undefined) this.scores.set(id, score * factor);
    }
  }

  async topStandings(limit: number): Promise<ManagerLadderStanding[]> {
    return [...this.scores.entries()]
      .filter(([, score]) => score > 0)
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
    if (this.titles.some((t) => t.tournamentId === title.tournamentId)) {
      throw new Error(`Tournament ${title.tournamentId} already has a title record`);
    }
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

/** Every existing SimulateMatchUseCase test predates peak-ranking/title
 * tracking and doesn't assert on either — this gives every call site a
 * real (not null-fallback) current week without touching each test's
 * own assertions. Tests that DO care about peak/title behavior build
 * their own instances instead of using this shared one. Synchronous on
 * purpose (no real I/O in the in-memory fake) so it drops into any
 * call site, sync or async, without an extra `await`. */
function makeTestWorld(week: GameWeek = { season: 1, week: 10 }): GameWorldRepository {
  const worlds = new InMemoryGameWorldRepository();
  void worlds.save(GameWorld.reconstitute({ id: testWorldId, currentWeek: week, lastAppliedTick: null }));
  return worlds;
}

/** Always declares entrantA (playerA) the winner, for deterministic
 * cascades through a bracket in these tests. */
class AlwaysAWinsSimulator implements MatchSimulator {
  simulate<S extends string>(playerA: MatchParticipant<S>, playerB: MatchParticipant<S>, _surface: Surface): SimulatedMatch<S> {
    return {
      outcome: {
        winner: playerA.playerId,
        loser: playerB.playerId,
        setScores: [{ winnerGames: 6, loserGames: 0 }],
      },
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

function makePlayer(id: PlayerId, managerId: ManagerId = ManagerId('m1')): Player {
  return Player.hire(id, id, 20 * 52, startingAttributes(), managerId);
}

function buildStartedTournament(
  tournamentId: TournamentId,
  entrantCount: number,
  drawSize: DrawSize,
  tier: TournamentTier = 'challenger',
): { tournament: Tournament; bracketGenerator: BracketGenerator } {
  const bracketGenerator = new BracketGenerator();
  const tournament = Tournament.open({ name: 'Test Tournament',
    id: tournamentId,
    tier,
    surface: 'hard',
    weekScheduled: { season: 1, week: 1 },
    drawSize,
  });

  for (let i = 1; i <= entrantCount; i++) {
    tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
  }

  const [round1] = bracketGenerator.generate(tournament.entrants, drawSize);
  tournament.startWithBracket([round1]);

  return { tournament, bracketGenerator };
}

describe('SimulateMatchUseCase', () => {
  it('generates and appends the next round once a non-final round completes', async () => {
    const tournamentId = TournamentId('t1');
    const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

    const tournaments = new InMemoryTournamentRepository();
    await tournaments.save(tournament);

    const players = new InMemoryPlayerRepository();
    for (let i = 1; i <= 16; i++) {
      await players.save(makePlayer(PlayerId(`p${i}`)));
    }

    const useCase = new SimulateMatchUseCase(
      tournaments,
      players,
      new AlwaysAWinsSimulator(),
      new FakeMatchLogStore(),
      new RecordingEventPublisher(),
      bracketGenerator,
      new StandardRankingPointsTable(),
      new InMemoryRankingLedgerRepository(),
      new StandardManagerXpPolicy(),
      new InMemoryManagerXpRepository(),
      new StandardManagerLadderPolicy(),
      new InMemoryManagerLadderRepository(),
      new InMemoryPeakRankingRepository(),
      new InMemoryTitleRepository(),
      makeTestWorld(),
      testWorldId,
      new StandardPlayerDevelopmentPolicy(),
    );

    const round1MatchCount = tournament.getRounds()[0].matches.length; // 8
    for (let matchIndex = 0; matchIndex < round1MatchCount; matchIndex++) {
      const saved = await tournaments.findById(tournamentId);
      expect(saved!.getRounds()).toHaveLength(1); // round 2 not generated until round 1 is fully done

      await useCase.execute({
        matchId: MatchId(`m${matchIndex}`),
        tournamentId,
        roundNumber: 1,
        matchIndex,
      });
    }

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.getRounds()).toHaveLength(2);
    expect(saved!.getRounds()[1].roundNumber).toBe(2);
    expect(saved!.getRounds()[1].matches).toHaveLength(4);
    expect(saved!.getRounds()[1].matches.every((m) => m.outcome === null)).toBe(true);
  });

  describe('automatic surface-affinity growth', () => {
    it('bumps both the winner and loser affinity for the surface actually played, and nothing else', async () => {
      const tournamentId = TournamentId('surface-t1');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16, 'challenger'); // 'hard'

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }

      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        new StandardRankingPointsTable(),
        new InMemoryRankingLedgerRepository(),
        new StandardManagerXpPolicy(),
        new InMemoryManagerXpRepository(),
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      // Read the actual slot 0 pairing rather than assuming p1 vs p2 —
      // BracketGenerator's seeding doesn't necessarily pair entrants in
      // registration order.
      const slot0 = tournament.getScheduledMatch(1, 0);
      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const winner = await players.findById(slot0.entrantA); // AlwaysAWinsSimulator: entrantA always wins
      const loser = await players.findById(slot0.entrantB);

      expect(winner!.attributes.surfaceAffinities.get('hard')).toBeCloseTo(20 + MATCH_SURFACE_AFFINITY_GAIN, 5);
      expect(loser!.attributes.surfaceAffinities.get('hard')).toBeCloseTo(20 + MATCH_SURFACE_AFFINITY_GAIN, 5);
      // Every other surface, and every skill, untouched.
      expect(winner!.attributes.surfaceAffinities.get('clay')).toBe(20);
      expect(winner!.attributes.surfaceAffinities.get('grass')).toBe(20);
      expect(winner!.attributes.surfaceAffinities.get('indoor')).toBe(20);
      expect(winner!.attributes.technical.serve.value).toBe(30);
    });

  });

  it('does not generate a further round once the final round completes, relying on TournamentCompleted instead', async () => {
    const tournamentId = TournamentId('t2');
    const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

    // Fabricate rounds 1-3 directly via the domain aggregate (entrantA
    // always wins) — only the final's single match is actually driven
    // through SimulateMatchUseCase, since that's what's under test.
    for (let roundNumber = 1; roundNumber <= 3; roundNumber++) {
      const round = tournament.getRounds()[roundNumber - 1];
      round.matches.forEach((m, matchIndex) => {
        tournament.recordMatchOutcome(roundNumber, matchIndex, {
          winner: m.entrantA,
          loser: m.entrantB,
          setScores: [],
        });
      });
      const nextRound = bracketGenerator.generateNextRound(
        tournament.getRounds()[roundNumber - 1],
        tournament.entrants,
        16,
      );
      tournament.addRound(nextRound);
    }
    tournament.pullDomainEvents(); // drain setup noise, not part of what's under test

    expect(tournament.getRounds()).toHaveLength(4);
    const finalMatch = tournament.getRounds()[3].matches[0];
    expect(tournament.getRounds()[3].matches).toHaveLength(1);

    const tournaments = new InMemoryTournamentRepository();
    await tournaments.save(tournament);

    const players = new InMemoryPlayerRepository();
    await players.save(makePlayer(finalMatch.entrantA));
    await players.save(makePlayer(finalMatch.entrantB));

    const events = new RecordingEventPublisher();
    const useCase = new SimulateMatchUseCase(
      tournaments,
      players,
      new AlwaysAWinsSimulator(),
      new FakeMatchLogStore(),
      events,
      bracketGenerator,
      new StandardRankingPointsTable(),
      new InMemoryRankingLedgerRepository(),
      new StandardManagerXpPolicy(),
      new InMemoryManagerXpRepository(),
      new StandardManagerLadderPolicy(),
      new InMemoryManagerLadderRepository(),
      new InMemoryPeakRankingRepository(),
      new InMemoryTitleRepository(),
      makeTestWorld(),
      testWorldId,
      new StandardPlayerDevelopmentPolicy(),
    );

    await useCase.execute({ matchId: MatchId('final'), tournamentId, roundNumber: 4, matchIndex: 0 });

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.getRounds()).toHaveLength(4); // no round 5 — nothing further to generate
    expect(events.published.some((e) => e.type === 'TournamentCompleted')).toBe(true);
  });

  describe('ranking points', () => {
    /** Cascades rounds 1..upToRound-1 of a 16-draw tournament via
     * SimulateMatchUseCase itself (not fabricated directly on the
     * aggregate), so the ranking-awarding path under test runs on
     * every decided match exactly as it would in production. Returns
     * the still-alive entrant reaching round `upToRound` at
     * matchIndex 0, i.e. the top of the bracket, since AlwaysAWinsSimulator
     * always advances entrantA. */
    async function cascadeToRound(
      useCase: SimulateMatchUseCase,
      tournaments: InMemoryTournamentRepository,
      tournamentId: TournamentId,
      upToRound: number,
    ): Promise<void> {
      for (let roundNumber = 1; roundNumber < upToRound; roundNumber++) {
        const tournament = (await tournaments.findById(tournamentId))!;
        const matchCount = tournament.getRounds()[roundNumber - 1].matches.length;
        for (let matchIndex = 0; matchIndex < matchCount; matchIndex++) {
          await useCase.execute({
            matchId: MatchId(`m-r${roundNumber}-${matchIndex}`),
            tournamentId,
            roundNumber,
            matchIndex,
          });
        }
      }
    }

    it('awards a first-round loser pointsFor(tier, 0) on the PLAYER, and awards the round-1 winner nothing yet', async () => {
      const tournamentId = TournamentId('t-r1');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }
      const firstMatch = tournament.getRounds()[0].matches[0];

      const rankingPointsTable = new StandardRankingPointsTable();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        rankingLedger,
        new StandardManagerXpPolicy(),
        new InMemoryManagerXpRepository(),
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const loserEntries = await rankingLedger.findByPlayer(firstMatch.entrantB);
      expect(loserEntries).toHaveLength(1);
      expect(loserEntries[0].points).toBe(rankingPointsTable.pointsFor('challenger', 0));
      expect(loserEntries[0].tournamentId).toBe(tournamentId);
      expect(loserEntries[0].tier).toBe('challenger');
      expect(loserEntries[0].weekEarned).toEqual({ season: 1, week: 1 });

      const winnerEntries = await rankingLedger.findByPlayer(firstMatch.entrantA);
      expect(winnerEntries).toHaveLength(0);
    });

    it('pays the round-1 loser real prize money, unlike ranking points which are 0 for a first-round loss', async () => {
      const tournamentId = TournamentId('t-r1-money');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }
      const firstMatch = tournament.getRounds()[0].matches[0];

      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        new StandardRankingPointsTable(),
        new InMemoryRankingLedgerRepository(),
        new StandardManagerXpPolicy(),
        new InMemoryManagerXpRepository(),
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const loser = await players.findById(firstMatch.entrantB);
      expect(loser!.careerPrizeMoney).toBeGreaterThan(0);
      expect(loser!.seasonPrizeMoney).toBe(loser!.careerPrizeMoney);

      // The winner hasn't been eliminated yet — no result recorded for
      // them at all this round, prize money included.
      const winner = await players.findById(firstMatch.entrantA);
      expect(winner!.careerPrizeMoney).toBe(0);
    });

    it('awards ranking points to a player even after they have been released (no manager)', async () => {
      const tournamentId = TournamentId('t-released');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }
      const firstMatch = tournament.getRounds()[0].matches[0];
      const loser = (await players.findById(firstMatch.entrantB))!;
      loser.releaseFromManager();
      await players.save(loser);

      const rankingPointsTable = new StandardRankingPointsTable();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        rankingLedger,
        new StandardManagerXpPolicy(),
        new InMemoryManagerXpRepository(),
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const loserEntries = await rankingLedger.findByPlayer(firstMatch.entrantB);
      expect(loserEntries).toHaveLength(1);
      expect(loserEntries[0].points).toBe(rankingPointsTable.pointsFor('challenger', 0));
    });

    /** Builds and cascades a 16-draw tournament through rounds 1-3, then
     * discovers whoever ended up in the round-4 final off the aggregate
     * rather than predicting bracket placement up front, since who
     * wins each earlier round is itself a moving part of the setup. */
    async function setupThroughSemifinals(tournamentId: TournamentId) {
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }

      const rankingPointsTable = new StandardRankingPointsTable();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const managerXpPolicy = new StandardManagerXpPolicy();
      const managerXp = new InMemoryManagerXpRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        rankingLedger,
        managerXpPolicy,
        managerXp,
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      await cascadeToRound(useCase, tournaments, tournamentId, 4);

      const finalTournament = (await tournaments.findById(tournamentId))!;
      const finalMatch = finalTournament.getRounds()[3].matches[0];
      // AlwaysAWinsSimulator always advances entrantA, so entrantA of
      // the final is the eventual champion and entrantB the runner-up.
      return {
        tournaments,
        players,
        useCase,
        rankingPointsTable,
        rankingLedger,
        managerXpPolicy,
        managerXp,
        champion: finalMatch.entrantA,
        finalist: finalMatch.entrantB,
      };
    }

    it('awards a finalist (loses the final after winning 3 rounds) pointsFor(tier, 3)', async () => {
      const { useCase, rankingPointsTable, rankingLedger, finalist } = await setupThroughSemifinals(
        TournamentId('t-finalist'),
      );

      await useCase.execute({
        matchId: MatchId('final'),
        tournamentId: TournamentId('t-finalist'),
        roundNumber: 4,
        matchIndex: 0,
      });

      const finalistEntries = await rankingLedger.findByPlayer(finalist);
      expect(finalistEntries).toHaveLength(1);
      expect(finalistEntries[0].points).toBe(rankingPointsTable.pointsFor('challenger', 3));
    });

    it('awards the champion pointsFor(tier, 4)', async () => {
      const { useCase, rankingPointsTable, rankingLedger, champion } = await setupThroughSemifinals(
        TournamentId('t-champion'),
      );

      await useCase.execute({
        matchId: MatchId('final'),
        tournamentId: TournamentId('t-champion'),
        roundNumber: 4,
        matchIndex: 0,
      });

      const championEntries = await rankingLedger.findByPlayer(champion);
      expect(championEntries).toHaveLength(1);
      expect(championEntries[0].points).toBe(rankingPointsTable.pointsFor('challenger', 4));
    });

  });

  describe('manager XP', () => {
    /** Every player in these fixtures shares the same manager (see
     * makePlayer's default), so a single match execution's XP credit
     * lands entirely on ManagerId('m1') — exactly what these
     * assertions read back via managerXp.balanceFor. */
    const MANAGER = ManagerId('m1');

    it('awards more XP for a win than a loss, at the same tier', async () => {
      const tournamentId = TournamentId('t-xp-win-vs-loss');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16, 'challenger');

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }

      const managerXpPolicy = new StandardManagerXpPolicy();
      const managerXp = new InMemoryManagerXpRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        new StandardRankingPointsTable(),
        new InMemoryRankingLedgerRepository(),
        managerXpPolicy,
        managerXp,
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      // A first-round match only ever awards the loser (see the ranking
      // points describe block above) — so this isolates the loss XP.
      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });
      const lossXp = await managerXp.balanceFor(MANAGER);
      expect(lossXp).toBe(managerXpPolicy.xpFor('loss', 'challenger'));

      // Now isolate a win: fabricate rounds 1-3 directly on the domain
      // aggregate (bypassing the use case, so no XP is awarded for
      // them) and drive ONLY the final through SimulateMatchUseCase —
      // same "isolate the final" pattern the top-level TournamentCompleted
      // test above uses, needed here so the winner's credit isn't mixed
      // in with three rounds' worth of eliminated-loser credits (every
      // player in this fixture shares the same manager).
      const winTournamentId = TournamentId('t-xp-win-only');
      const { tournament: winTournament, bracketGenerator: winBracketGenerator } = buildStartedTournament(
        winTournamentId,
        16,
        16,
        'challenger',
      );
      for (let roundNumber = 1; roundNumber <= 3; roundNumber++) {
        const round = winTournament.getRounds()[roundNumber - 1];
        round.matches.forEach((m, matchIndex) => {
          winTournament.recordMatchOutcome(roundNumber, matchIndex, {
            winner: m.entrantA,
            loser: m.entrantB,
            setScores: [],
          });
        });
        const nextRound = winBracketGenerator.generateNextRound(
          winTournament.getRounds()[roundNumber - 1],
          winTournament.entrants,
          16,
        );
        winTournament.addRound(nextRound);
      }
      winTournament.pullDomainEvents();

      const winTournaments = new InMemoryTournamentRepository();
      await winTournaments.save(winTournament);
      const winPlayers = new InMemoryPlayerRepository();
      const finalMatch = winTournament.getRounds()[3].matches[0];
      await winPlayers.save(makePlayer(finalMatch.entrantA, MANAGER));
      await winPlayers.save(makePlayer(finalMatch.entrantB, MANAGER));

      const winManagerXp = new InMemoryManagerXpRepository();
      const winUseCase = new SimulateMatchUseCase(
        winTournaments,
        winPlayers,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        winBracketGenerator,
        new StandardRankingPointsTable(),
        new InMemoryRankingLedgerRepository(),
        managerXpPolicy,
        winManagerXp,
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      await winUseCase.execute({ matchId: MatchId('final'), tournamentId: winTournamentId, roundNumber: 4, matchIndex: 0 });

      // The final awards the loser (runner-up) AND the winner (champion)
      // — both to the same shared manager here — so the total is
      // win + loss XP, which must exceed a bare loss's worth by more
      // than zero, confirming the win bonus actually applied.
      const winPlusLossXp = await winManagerXp.balanceFor(MANAGER);
      expect(winPlusLossXp).toBe(
        managerXpPolicy.xpFor('win', 'challenger') + managerXpPolicy.xpFor('loss', 'challenger'),
      );
      expect(winPlusLossXp - lossXp).toBeGreaterThan(0);
    });

    it('credits the deciding match XP to the player\'s manager, not the player, and scales by tier', async () => {
      const futuresId = TournamentId('t-xp-futures');
      const majorId = TournamentId('t-xp-major');

      async function lossXpAt(tournamentId: TournamentId, tier: TournamentTier): Promise<number> {
        const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16, tier);
        const tournaments = new InMemoryTournamentRepository();
        await tournaments.save(tournament);

        const players = new InMemoryPlayerRepository();
        for (let i = 1; i <= 16; i++) {
          await players.save(makePlayer(PlayerId(`p${i}`)));
        }

        const managerXp = new InMemoryManagerXpRepository();
        const useCase = new SimulateMatchUseCase(
          tournaments,
          players,
          new AlwaysAWinsSimulator(),
          new FakeMatchLogStore(),
          new RecordingEventPublisher(),
          bracketGenerator,
          new StandardRankingPointsTable(),
          new InMemoryRankingLedgerRepository(),
          new StandardManagerXpPolicy(),
          managerXp,
          new StandardManagerLadderPolicy(),
          new InMemoryManagerLadderRepository(),
          new InMemoryPeakRankingRepository(),
          new InMemoryTitleRepository(),
          makeTestWorld(),
          testWorldId,
          new StandardPlayerDevelopmentPolicy(),
        );

        await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });
        return managerXp.balanceFor(MANAGER);
      }

      const futuresXp = await lossXpAt(futuresId, 'futures');
      const majorXp = await lossXpAt(majorId, 'major');

      expect(majorXp).toBeGreaterThan(futuresXp);
    });

    it('awards no XP to anyone for a player who has been released (no manager)', async () => {
      const tournamentId = TournamentId('t-xp-released');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16, 'challenger');

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }
      const firstMatch = tournament.getRounds()[0].matches[0];
      const loser = (await players.findById(firstMatch.entrantB))!;
      loser.releaseFromManager();
      await players.save(loser);

      const managerXp = new InMemoryManagerXpRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        new StandardRankingPointsTable(),
        new InMemoryRankingLedgerRepository(),
        new StandardManagerXpPolicy(),
        managerXp,
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      expect(await managerXp.balanceFor(MANAGER)).toBe(0);
    });
  });

  describe('manager ladder', () => {
    const MANAGER = ManagerId('m1');

    it('banks ranking points onto the manager ladder at the same event as the ranking ledger', async () => {
      const tournamentId = TournamentId('t-ladder-loss');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16, 'challenger');
      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);
      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) await players.save(makePlayer(PlayerId(`p${i}`)));

      const rankingLedger = new InMemoryRankingLedgerRepository();
      const ladderPolicy = new StandardManagerLadderPolicy();
      const ladder = new InMemoryManagerLadderRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        new StandardRankingPointsTable(),
        rankingLedger,
        new StandardManagerXpPolicy(),
        new InMemoryManagerXpRepository(),
        ladderPolicy,
        ladder,
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      // A first-round match awards the loser their (roundsWon=0) result.
      const firstMatch = tournament.getRounds()[0].matches[0];
      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const loserEntries = await rankingLedger.findByPlayer(firstMatch.entrantB);
      const bankedPoints = loserEntries[0].points;
      // The ladder score equals the ranking points that manager's
      // player earned (RR: managers accumulate all their players' points).
      expect(await ladder.scoreFor(MANAGER)).toBe(ladderPolicy.creditFor(bankedPoints));
    });

    it('never credits the ladder for a released (manager-less) player', async () => {
      const tournamentId = TournamentId('t-ladder-released');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16, 'challenger');
      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);
      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) await players.save(makePlayer(PlayerId(`p${i}`)));
      const firstMatch = tournament.getRounds()[0].matches[0];
      const loser = (await players.findById(firstMatch.entrantB))!;
      loser.releaseFromManager();
      await players.save(loser);

      const ladder = new InMemoryManagerLadderRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        new StandardRankingPointsTable(),
        new InMemoryRankingLedgerRepository(),
        new StandardManagerXpPolicy(),
        new InMemoryManagerXpRepository(),
        new StandardManagerLadderPolicy(),
        ladder,
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });
      expect(await ladder.scoreFor(MANAGER)).toBe(0);
    });
  });

  describe('graduation carryover', () => {
    /** A junior tournament in the given band, cascaded far enough for
     * one player (entrantA at every round, per AlwaysAWinsSimulator)
     * to accumulate real wins before eventually losing — a win-then-
     * lose player gets a ledger entry with roundsWon >= 1 (points >
     * 0) the moment they lose, without needing to cascade all the way
     * to a champion. */
    function openJuniorTournament(id: TournamentId, ageBand: 'u14' | 'u16' = 'u16'): { tournament: Tournament; bracketGenerator: BracketGenerator } {
      const bracketGenerator = new BracketGenerator();
      const tournament = Tournament.open({ name: 'Test Tournament',
        id,
        tier: 'j100',
        ageBand,
        surface: 'hard',
        weekScheduled: { season: 1, week: 1 },
        drawSize: 16,
      });
      for (let i = 1; i <= 16; i++) {
        tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
      }
      const [round1] = bracketGenerator.generate(tournament.entrants, 16);
      tournament.startWithBracket([round1]);
      return { tournament, bracketGenerator };
    }

    function buildUseCase(
      tournaments: InMemoryTournamentRepository,
      players: InMemoryPlayerRepository,
      rankingLedger: InMemoryRankingLedgerRepository,
      bracketGenerator: BracketGenerator,
    ): SimulateMatchUseCase {
      return new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        new StandardRankingPointsTable(),
        rankingLedger,
        new StandardManagerXpPolicy(),
        new InMemoryManagerXpRepository(),
        new StandardManagerLadderPolicy(),
        new InMemoryManagerLadderRepository(),
        new InMemoryPeakRankingRepository(),
        new InMemoryTitleRepository(),
        makeTestWorld(),
        testWorldId,
        new StandardPlayerDevelopmentPolicy(),
      );
    }

    /** Plays out every match of every round in order, so seed 1 (always
     * entrantA, per AlwaysAWinsSimulator) ends up the outright
     * champion — the simplest way to get them a real, points > 0
     * ranking-ledger entry, since a winner is only awarded points the
     * moment they win the FINAL (see SimulateMatchUseCase's doc
     * comment). Round N+1 only exists once every match of round N is
     * decided, so this has to complete a round in full before reading
     * the next one back off the repository. */
    async function cascadeToChampion(
      useCase: SimulateMatchUseCase,
      tournaments: InMemoryTournamentRepository,
      tournamentId: TournamentId,
      totalRounds: number,
    ): Promise<void> {
      for (let roundNumber = 1; roundNumber <= totalRounds; roundNumber++) {
        const tournament = (await tournaments.findById(tournamentId))!;
        const matchCount = tournament.getRounds()[roundNumber - 1].matches.length;
        for (let matchIndex = 0; matchIndex < matchCount; matchIndex++) {
          await useCase.execute({
            matchId: MatchId(`${tournamentId}-r${roundNumber}-m${matchIndex}`),
            tournamentId,
            roundNumber,
            matchIndex,
          });
        }
      }
    }

    it("does NOT consume the dormant bonus (or boost anything) on a 0-point first-round loss in the target band — a ranking must be earned, not just entered", async () => {
      const tournamentId = TournamentId('t-loss');
      const { tournament, bracketGenerator } = openJuniorTournament(tournamentId, 'u16');

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);
      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) await players.save(makePlayer(PlayerId(`p${i}`)));

      const loser = (await players.findById(PlayerId('p16')))!; // entrantB of round-1 match 0 (seed1 vs seed16)
      const dormant = { targetBand: 'u16' as const, bonusPoints: 999 };
      loser.setDormantCarryoverBonus(dormant);
      await players.save(loser);

      const rankingLedger = new InMemoryRankingLedgerRepository();
      const useCase = buildUseCase(tournaments, players, rankingLedger, bracketGenerator);

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const entries = await rankingLedger.findByPlayer(PlayerId('p16'));
      expect(entries).toHaveLength(1);
      expect(entries[0].points).toBe(0); // no manufactured ranking

      const reloaded = await players.findById(PlayerId('p16'));
      expect(reloaded!.dormantCarryoverBonus).toEqual(dormant); // still dormant, untouched
    });

    it("boosts a player's first real (points > 0) result in the target band by the dormant bonus, then clears it", async () => {
      const tournamentId = TournamentId('t-win');
      const { tournament, bracketGenerator } = openJuniorTournament(tournamentId, 'u16');

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);
      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) await players.save(makePlayer(PlayerId(`p${i}`)));

      const p1 = (await players.findById(PlayerId('p1')))!; // seed 1 — always entrantA, so always the AlwaysAWinsSimulator winner
      const dormant = { targetBand: 'u16' as const, bonusPoints: 50 };
      p1.setDormantCarryoverBonus(dormant);
      await players.save(p1);

      const rankingLedger = new InMemoryRankingLedgerRepository();
      const useCase = buildUseCase(tournaments, players, rankingLedger, bracketGenerator);

      // p1 wins every round of this 16-draw (4 rounds), becoming
      // champion — their ranking-ledger entry is awarded the instant
      // they win the final, with roundsWon = 4.
      await cascadeToChampion(useCase, tournaments, tournamentId, 4);

      const rawPoints = new StandardRankingPointsTable().pointsFor('j100', 4);
      expect(rawPoints).toBeGreaterThan(0);
      const entries = await rankingLedger.findByPlayer(PlayerId('p1'));
      expect(entries).toHaveLength(1);
      expect(entries[0].points).toBe(rawPoints + dormant.bonusPoints);

      const reloaded = await players.findById(PlayerId('p1'));
      expect(reloaded!.dormantCarryoverBonus).toBeNull(); // consumed
    });

    it('does NOT apply the bonus to a second qualifying result — only the first one consumes it', async () => {
      const players = new InMemoryPlayerRepository();
      await players.save(makePlayer(PlayerId('p1')));
      const p1 = (await players.findById(PlayerId('p1')))!;
      const dormant = { targetBand: 'u16' as const, bonusPoints: 50 };
      p1.setDormantCarryoverBonus(dormant);
      await players.save(p1);

      const tournaments = new InMemoryTournamentRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository();

      // Two separate junior tournaments, same player (seed 1, always
      // champion under AlwaysAWinsSimulator), same target band.
      for (const tid of ['t-a', 't-b']) {
        const bracketGenerator = new BracketGenerator();
        const tournament = Tournament.open({ name: 'Test Tournament',
          id: TournamentId(tid),
          tier: 'j100',
          ageBand: 'u16',
          surface: 'hard',
          weekScheduled: { season: 1, week: 1 },
          drawSize: 16,
        });
        tournament.registerEntrant({ playerId: PlayerId('p1'), seed: 1 });
        for (let i = 2; i <= 16; i++) {
          tournament.registerEntrant({ playerId: PlayerId(`${tid}-p${i}`), seed: i });
          await players.save(makePlayer(PlayerId(`${tid}-p${i}`)));
        }
        const [round1] = bracketGenerator.generate(tournament.entrants, 16);
        tournament.startWithBracket([round1]);
        await tournaments.save(tournament);

        const useCase = buildUseCase(tournaments, players, rankingLedger, bracketGenerator);
        await cascadeToChampion(useCase, tournaments, TournamentId(tid), 4);
      }

      const rawPoints = new StandardRankingPointsTable().pointsFor('j100', 4);
      const entries = await rankingLedger.findByPlayer(PlayerId('p1'));
      expect(entries).toHaveLength(2);
      const [first, second] = entries;
      expect(first.points).toBe(rawPoints + dormant.bonusPoints); // boosted — first qualifying result
      expect(second.points).toBe(rawPoints); // NOT boosted — bonus already consumed by the first
    });

    it('does NOT apply a dormant bonus to a real (points > 0) result in a different band than the one it targets', async () => {
      const tournamentId = TournamentId('t-senior');
      const bracketGenerator = new BracketGenerator();
      const tournament = Tournament.open({ name: 'Test Tournament',
        id: tournamentId,
        tier: 'challenger', // senior tier -> ageBand null -> band 'senior'
        surface: 'hard',
        weekScheduled: { season: 1, week: 1 },
        drawSize: 16,
      });
      for (let i = 1; i <= 16; i++) tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
      const [round1] = bracketGenerator.generate(tournament.entrants, 16);
      tournament.startWithBracket([round1]);

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);
      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) await players.save(makePlayer(PlayerId(`p${i}`)));

      // p1 wins the whole senior draw — a real (points > 0) senior-band
      // entry — while holding a dormant bonus that targets 'u16', not
      // 'senior'.
      const p1 = (await players.findById(PlayerId('p1')))!;
      const dormant = { targetBand: 'u16' as const, bonusPoints: 999 };
      p1.setDormantCarryoverBonus(dormant);
      await players.save(p1);

      const rankingLedger = new InMemoryRankingLedgerRepository();
      const useCase = buildUseCase(tournaments, players, rankingLedger, bracketGenerator);

      await cascadeToChampion(useCase, tournaments, tournamentId, 4);

      const rawPoints = new StandardRankingPointsTable().pointsFor('challenger', 4);
      expect(rawPoints).toBeGreaterThan(0);
      const entries = await rankingLedger.findByPlayer(PlayerId('p1'));
      expect(entries).toHaveLength(1);
      expect(entries[0].points).toBe(rawPoints); // NOT boosted — wrong band

      const reloaded = await players.findById(PlayerId('p1'));
      expect(reloaded!.dormantCarryoverBonus).toEqual(dormant); // untouched, still dormant
    });
  });
});

describe('SimulateMatchUseCase — peak ranking and titles (docs/data-archival-principles.md)', () => {
  /** DrawSize only allows 16/32/64/128 — there is no genuinely smaller
   * real tournament. `playerIds` must be exactly 16, already in SEED
   * order (playerIds[0] = seed 1, ..., playerIds[15] = seed 16). */
  function buildFullTournament(
    tournamentId: TournamentId,
    tier: TournamentTier,
    ageBand: 'u14' | 'u16' | null,
    playerIds: PlayerId[],
  ): { tournament: Tournament; bracketGenerator: BracketGenerator } {
    const bracketGenerator = new BracketGenerator();
    const tournament = Tournament.open({
      name: 'Test Championship',
      id: tournamentId,
      tier,
      ageBand,
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    playerIds.forEach((id, i) => tournament.registerEntrant({ playerId: id, seed: i + 1 }));
    const [round1] = bracketGenerator.generate(tournament.entrants, 16);
    tournament.startWithBracket([round1]);
    return { tournament, bracketGenerator };
  }

  /** Standard seed-slot pairing puts seed 1 vs seed 16 at round 1,
   * match index 0 — so putting a player at seed 16 against 15 filler
   * opponents, then simulating ONLY that one match, gives them a real,
   * immediate first-round-loss ledger entry (0 points) with no need to
   * cascade the rest of the bracket at all. */
  function seededFillerIds(prefix: string, count = 15): PlayerId[] {
    return Array.from({ length: count }, (_, i) => PlayerId(`${prefix}-filler-${i + 1}`));
  }

  /** Plays out every match of every round in seed order, so seed 1
   * (always entrantA under AlwaysAWinsSimulator, and always paired
   * against the lowest remaining seed) ends up outright champion —
   * same pattern this file's own graduation-carryover tests already
   * rely on elsewhere. */
  async function cascadeToChampion(
    useCase: SimulateMatchUseCase,
    tournaments: InMemoryTournamentRepository,
    tournamentId: TournamentId,
    totalRounds: number,
  ): Promise<void> {
    for (let roundNumber = 1; roundNumber <= totalRounds; roundNumber++) {
      const tournament = (await tournaments.findById(tournamentId))!;
      const matchCount = tournament.getRounds()[roundNumber - 1].matches.length;
      for (let matchIndex = 0; matchIndex < matchCount; matchIndex++) {
        await useCase.execute({
          matchId: MatchId(`${tournamentId}-r${roundNumber}-m${matchIndex}`),
          tournamentId,
          roundNumber,
          matchIndex,
        });
      }
    }
  }

  function buildDeps() {
    const tournaments = new InMemoryTournamentRepository();
    const players = new InMemoryPlayerRepository();
    const rankingLedger = new InMemoryRankingLedgerRepository();
    const peakRankings = new InMemoryPeakRankingRepository();
    const titles = new InMemoryTitleRepository();
    return { tournaments, players, rankingLedger, peakRankings, titles };
  }

  function makeUseCase(
    deps: ReturnType<typeof buildDeps>,
    bracketGenerator: BracketGenerator,
    worlds: GameWorldRepository,
  ): SimulateMatchUseCase {
    return new SimulateMatchUseCase(
      deps.tournaments,
      deps.players,
      new AlwaysAWinsSimulator(),
      new FakeMatchLogStore(),
      new RecordingEventPublisher(),
      bracketGenerator,
      new StandardRankingPointsTable(),
      deps.rankingLedger,
      new StandardManagerXpPolicy(),
      new InMemoryManagerXpRepository(),
      new StandardManagerLadderPolicy(),
      new InMemoryManagerLadderRepository(),
      deps.peakRankings,
      deps.titles,
      worlds,
      testWorldId,
      new StandardPlayerDevelopmentPolicy(),
    );
  }

  it("stays at its high point even after the player's rolling ranking later drops (an older result rolling out of the 52-week window)", async () => {
    const p1 = PlayerId('peak-p1');
    const deps = buildDeps();
    const winnerFieldIds = [p1, ...seededFillerIds('peak-a')];
    for (const id of winnerFieldIds) await deps.players.save(makePlayer(id));

    // Champion run #1, "now" = season 1 week 10 — a real, big, nonzero
    // result (a true final win, roundsWon = 4 on a 16-draw).
    const { tournament: tA, bracketGenerator: bgA } = buildFullTournament(TournamentId('peak-t-a'), 'challenger', null, winnerFieldIds);
    await deps.tournaments.save(tA);
    const useCaseA = makeUseCase(deps, bgA, makeTestWorld({ season: 1, week: 10 }));
    await cascadeToChampion(useCaseA, deps.tournaments, tA.id, 4);

    const rawWinPoints = new StandardRankingPointsTable().pointsFor('challenger', 4);
    expect(rawWinPoints).toBeGreaterThan(0);
    const peakAfterWin = await deps.peakRankings.findOne(p1, 'senior');
    expect(peakAfterWin?.peakPoints).toBe(rawWinPoints);

    // Loss #2, "now" = season 2 week 5 — far enough past win #1's week
    // 1 (weeksBetween = 52 + 5 - 1 = 56 > 52) that it has rolled OUT of
    // the rolling window entirely. p1 sits at seed 16 this time (paired
    // against seed 1 at round 1, match 0), so simulating ONLY that one
    // match gives them a real, immediate 0-point first-round-exit
    // entry with no need to cascade the rest of this bracket.
    const loserFieldIds = [...seededFillerIds('peak-b'), p1];
    const { tournament: tB, bracketGenerator: bgB } = buildFullTournament(TournamentId('peak-t-b'), 'challenger', null, loserFieldIds);
    for (const id of loserFieldIds) if (!(await deps.players.findById(id))) await deps.players.save(makePlayer(id));
    await deps.tournaments.save(tB);
    const useCaseB = makeUseCase(deps, bgB, makeTestWorld({ season: 2, week: 5 }));
    await useCaseB.execute({ matchId: MatchId('peak-m-b'), tournamentId: tB.id, roundNumber: 1, matchIndex: 0 });

    // The fresh rolling total really did drop (sanity check, not just
    // asserting the peak alone).
    const freshEntries = (await deps.rankingLedger.findByPlayer(p1)).filter((e) => e.ageBand === null);
    expect(freshEntries.some((e) => e.points === 0)).toBe(true); // the later 0-point loss is recorded

    // The peak must be UNCHANGED — still the champion run's points,
    // never reduced to reflect the fresh (now lower) rolling total.
    const peakAfterDrop = await deps.peakRankings.findOne(p1, 'senior');
    expect(peakAfterDrop?.peakPoints).toBe(rawWinPoints);
  });

  it('keeps a U14 peak untouched and independently queryable after the same player later earns a U16 result (graduating bands)', async () => {
    const p1 = PlayerId('grad-p1');
    const deps = buildDeps();
    const u14FieldIds = [p1, ...seededFillerIds('grad-u14')];
    const u16FieldIds = [p1, ...seededFillerIds('grad-u16')];
    for (const id of [...new Set([...u14FieldIds, ...u16FieldIds])]) await deps.players.save(makePlayer(id));

    // A real U14 championship run.
    const { tournament: tU14, bracketGenerator: bgU14 } = buildFullTournament(TournamentId('grad-t-u14'), 'j100', 'u14', u14FieldIds);
    await deps.tournaments.save(tU14);
    const useCaseU14 = makeUseCase(deps, bgU14, makeTestWorld({ season: 1, week: 5 }));
    await cascadeToChampion(useCaseU14, deps.tournaments, tU14.id, 4);

    const juniorPeakPoints = new StandardRankingPointsTable().pointsFor('j100', 4);
    expect(juniorPeakPoints).toBeGreaterThan(0);
    const u14PeakAfterWin = await deps.peakRankings.findOne(p1, 'u14');
    expect(u14PeakAfterWin?.peakPoints).toBe(juniorPeakPoints);

    // Later, the SAME player (now competing in U16 — this test only
    // checks the peak table's per-band isolation, not age-eligibility
    // enforcement, which RegisterEntrantUseCase already covers) earns
    // a real U16 championship run too — a completely independent band.
    const { tournament: tU16, bracketGenerator: bgU16 } = buildFullTournament(TournamentId('grad-t-u16'), 'j100', 'u16', u16FieldIds);
    await deps.tournaments.save(tU16);
    const useCaseU16 = makeUseCase(deps, bgU16, makeTestWorld({ season: 1, week: 20 }));
    await cascadeToChampion(useCaseU16, deps.tournaments, tU16.id, 4);

    // The U14 peak is untouched by the U16 result.
    const u14PeakAfterGraduating = await deps.peakRankings.findOne(p1, 'u14');
    expect(u14PeakAfterGraduating?.peakPoints).toBe(juniorPeakPoints);

    // And it's still independently queryable alongside the new U16
    // peak — both rows present, not one overwriting the other.
    const allPeaks = await deps.peakRankings.findAllForPlayer(p1);
    const bands = allPeaks.map((p) => p.band).sort();
    expect(bands).toEqual(['u14', 'u16']);
  });

  it('produces exactly one title record for the winner, and none for the runner-up or anyone eliminated earlier', async () => {
    const champion = PlayerId('title-champion');
    const fieldIds = [champion, ...seededFillerIds('title')];
    const deps = buildDeps();
    for (const id of fieldIds) await deps.players.save(makePlayer(id));

    const { tournament, bracketGenerator } = buildFullTournament(TournamentId('title-t1'), 'challenger', null, fieldIds);
    await deps.tournaments.save(tournament);
    const useCase = makeUseCase(deps, bracketGenerator, makeTestWorld());
    await cascadeToChampion(useCase, deps.tournaments, tournament.id, 4);

    const finished = (await deps.tournaments.findById(tournament.id))!;
    const finalMatch = finished.getRounds()[3].matches[0];
    expect(finalMatch.outcome!.winner).toBe(champion); // sanity: seed 1 really did win it all

    const championTitles = await deps.titles.findByPlayer(champion);
    expect(championTitles).toHaveLength(1);
    expect(championTitles[0].tournamentId).toBe(tournament.id);

    const runnerUpTitles = await deps.titles.findByPlayer(finalMatch.outcome!.loser);
    expect(runnerUpTitles).toHaveLength(0);

    // A player eliminated in round 1 (never reached the final at all).
    const earlyExitTitles = await deps.titles.findByPlayer(fieldIds[8]);
    expect(earlyExitTitles).toHaveLength(0);
  });

  it('awards NO title to anyone from a non-final round decided match — only the actual final does', async () => {
    const fieldIds = seededFillerIds('nofinal', 16);
    const deps = buildDeps();
    for (const id of fieldIds) await deps.players.save(makePlayer(id));

    const { tournament, bracketGenerator } = buildFullTournament(TournamentId('nofinal-t1'), 'challenger', null, fieldIds);
    await deps.tournaments.save(tournament);

    const useCase = makeUseCase(deps, bracketGenerator, makeTestWorld());
    // Only round 1's first match (seed 1 vs seed 16) — nowhere near the
    // final (round 4) of a 16-draw.
    await useCase.execute({ matchId: MatchId('nofinal-m1'), tournamentId: tournament.id, roundNumber: 1, matchIndex: 0 });

    const allTitles = await Promise.all(fieldIds.map((id) => deps.titles.findByPlayer(id)));
    expect(allTitles.flat()).toHaveLength(0);
  });
});

describe('SimulateMatchUseCase — home advantage (P6)', () => {
  class CapturingSimulator implements MatchSimulator {
    lastA: MatchParticipant<string> | null = null;
    lastB: MatchParticipant<string> | null = null;
    simulate<S extends string>(playerA: MatchParticipant<S>, playerB: MatchParticipant<S>, _surface: Surface): SimulatedMatch<S> {
      this.lastA = playerA;
      this.lastB = playerB;
      return {
        outcome: { winner: playerA.playerId, loser: playerB.playerId, setScores: [{ winnerGames: 6, loserGames: 0 }] },
        log: { entries: [], points: [], totalDurationSeconds: 0 },
      };
    }
  }

  function makeUseCaseWith(
    tournaments: InMemoryTournamentRepository,
    players: InMemoryPlayerRepository,
    simulator: MatchSimulator,
  ): SimulateMatchUseCase {
    return new SimulateMatchUseCase(
      tournaments,
      players,
      simulator,
      new FakeMatchLogStore(),
      new RecordingEventPublisher(),
      new BracketGenerator(),
      new StandardRankingPointsTable(),
      new InMemoryRankingLedgerRepository(),
      new StandardManagerXpPolicy(),
      new InMemoryManagerXpRepository(),
      new StandardManagerLadderPolicy(),
      new InMemoryManagerLadderRepository(),
      new InMemoryPeakRankingRepository(),
      new InMemoryTitleRepository(),
      makeTestWorld(),
      testWorldId,
      new StandardPlayerDevelopmentPolicy(),
    );
  }

  /** Seed 1 (entrantA) meets seed 16 (entrantB) at round 1, match 0. */
  async function runFirstMatch(
    hostCountry: string | null,
    seed1Nationality: string,
    seed16Nationality: string,
  ): Promise<CapturingSimulator> {
    const bracketGenerator = new BracketGenerator();
    const tournament = Tournament.open({
      name: 'Home Test Open',
      id: TournamentId('home-t1'),
      tier: 'challenger',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
      hostCountry,
    });
    for (let i = 1; i <= 16; i++) tournament.registerEntrant({ playerId: PlayerId(`hp${i}`), seed: i });
    const [round1] = bracketGenerator.generate(tournament.entrants, 16);
    tournament.startWithBracket([round1]);

    const tournaments = new InMemoryTournamentRepository();
    await tournaments.save(tournament);

    const players = new InMemoryPlayerRepository();
    for (let i = 1; i <= 16; i++) {
      const nationality = i === 1 ? seed1Nationality : i === 16 ? seed16Nationality : 'ZZ';
      await players.save(
        Player.hire(PlayerId(`hp${i}`), `hp${i}`, 20 * 52, startingAttributes(), ManagerId('m1'), nationality),
      );
    }

    const simulator = new CapturingSimulator();
    const useCase = makeUseCaseWith(tournaments, players, simulator);
    await useCase.execute({ matchId: MatchId('home-m1'), tournamentId: TournamentId('home-t1'), roundNumber: 1, matchIndex: 0 });
    return simulator;
  }

  it('flags the player whose nationality matches the host country as home, and only them', async () => {
    const simulator = await runFirstMatch('Spain', 'Spain', 'Italy');
    expect(simulator.lastA?.homeAdvantage).toBe(true);
    expect(simulator.lastB?.homeAdvantage).toBe(false);
  });

  it('flags neither player when the host country matches no one', async () => {
    const simulator = await runFirstMatch('Spain', 'Italy', 'France');
    expect(simulator.lastA?.homeAdvantage).toBe(false);
    expect(simulator.lastB?.homeAdvantage).toBe(false);
  });

  it('flags no one when the tournament has no host country (pre-P6 rows, tests)', async () => {
    const simulator = await runFirstMatch(null, 'Spain', 'Spain');
    expect(simulator.lastA?.homeAdvantage).toBe(false);
    expect(simulator.lastB?.homeAdvantage).toBe(false);
  });
});
