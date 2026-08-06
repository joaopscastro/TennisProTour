import { describe, expect, it } from 'vitest';
import { GameWeek, ManagerId, MatchId, PlayerId, TournamentId, RankingLedgerEntry } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { DrawSize, MatchLog, TournamentTier } from '@tennis-manager/domain';
import { MatchParticipant, MatchSimulator, SimulatedMatch } from '@tennis-manager/domain';
import { StandardManagerXpPolicy, StandardRankingPointsTable } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
import {
  EventPublisherPort,
  ManagerXpRepository,
  RankingLedgerRepository,
  MatchLogStorePort,
  PlayerRepository,
  TournamentRepository,
} from '../ports/ports';
import { SimulateMatchUseCase } from './SimulateMatchUseCase';

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

/** Always declares entrantA (playerA) the winner, for deterministic
 * cascades through a bracket in these tests. */
class AlwaysAWinsSimulator implements MatchSimulator {
  simulate(playerA: MatchParticipant, playerB: MatchParticipant, _surface: Surface): SimulatedMatch {
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
  const tournament = Tournament.open({
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
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      expect(await managerXp.balanceFor(MANAGER)).toBe(0);
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
      const tournament = Tournament.open({
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
        const tournament = Tournament.open({
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
      const tournament = Tournament.open({
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
