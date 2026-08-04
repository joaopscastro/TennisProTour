import { describe, expect, it } from 'vitest';
import { ManagerId, ManagerRanking, MatchId, PlayerId, TournamentId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { DrawSize, MatchLog } from '@tennis-manager/domain';
import { MatchParticipant, MatchSimulator, SimulatedMatch } from '@tennis-manager/domain';
import { StandardRankingPointsTable } from '@tennis-manager/domain';
import { Surface } from '@tennis-manager/domain';
import {
  EventPublisherPort,
  ManagerRankingRepository,
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

class InMemoryManagerRankingRepository implements ManagerRankingRepository {
  private readonly store = new Map<ManagerId, ManagerRanking>();

  async findById(managerId: ManagerId): Promise<ManagerRanking | null> {
    return this.store.get(managerId) ?? null;
  }

  async save(ranking: ManagerRanking): Promise<void> {
    this.store.set(ranking.managerId, ranking);
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
): { tournament: Tournament; bracketGenerator: BracketGenerator } {
  const bracketGenerator = new BracketGenerator();
  const tournament = Tournament.open({
    id: tournamentId,
    tier: 'challenger',
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
      new InMemoryManagerRankingRepository(),
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
      new InMemoryManagerRankingRepository(),
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

    it('awards a first-round loser pointsFor(tier, 0), and awards the round-1 winner nothing yet', async () => {
      const tournamentId = TournamentId('t-r1');
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const winnerManager = ManagerId('winner-mgr');
      const loserManager = ManagerId('loser-mgr');
      const players = new InMemoryPlayerRepository();
      const firstMatch = tournament.getRounds()[0].matches[0];
      await players.save(makePlayer(firstMatch.entrantA, winnerManager));
      await players.save(makePlayer(firstMatch.entrantB, loserManager));
      for (let i = 1; i <= 16; i++) {
        const id = PlayerId(`p${i}`);
        if (id === firstMatch.entrantA || id === firstMatch.entrantB) continue;
        await players.save(makePlayer(id));
      }

      const rankingPointsTable = new StandardRankingPointsTable();
      const managerRankings = new InMemoryManagerRankingRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        managerRankings,
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const loserRanking = await managerRankings.findById(loserManager);
      expect(loserRanking?.totalPoints).toBe(rankingPointsTable.pointsFor('challenger', 0));

      const winnerRanking = await managerRankings.findById(winnerManager);
      expect(winnerRanking).toBeNull();
    });

    /** Builds and cascades a 16-draw tournament through rounds 1-3 (all
     * players under a shared default manager), then reassigns whoever
     * ended up in the round-4 final to their own distinct managers —
     * discovering the actual finalists off the aggregate rather than
     * predicting bracket placement up front, since who wins each
     * earlier round is themselves a moving part of the setup. */
    async function setupThroughSemifinals(tournamentId: TournamentId) {
      const { tournament, bracketGenerator } = buildStartedTournament(tournamentId, 16, 16);

      const tournaments = new InMemoryTournamentRepository();
      await tournaments.save(tournament);

      const players = new InMemoryPlayerRepository();
      for (let i = 1; i <= 16; i++) {
        await players.save(makePlayer(PlayerId(`p${i}`)));
      }

      const rankingPointsTable = new StandardRankingPointsTable();
      const managerRankings = new InMemoryManagerRankingRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        managerRankings,
      );

      await cascadeToRound(useCase, tournaments, tournamentId, 4);

      const finalTournament = (await tournaments.findById(tournamentId))!;
      const finalMatch = finalTournament.getRounds()[3].matches[0];
      const championManager = ManagerId('champion-mgr');
      const finalistManager = ManagerId('finalist-mgr');
      // AlwaysAWinsSimulator always advances entrantA, so entrantA of
      // the final is the eventual champion and entrantB the runner-up.
      await players.save(makePlayer(finalMatch.entrantA, championManager));
      await players.save(makePlayer(finalMatch.entrantB, finalistManager));

      return { tournaments, useCase, rankingPointsTable, managerRankings, championManager, finalistManager };
    }

    it('awards a finalist (loses the final after winning 3 rounds) pointsFor(tier, 3)', async () => {
      const { useCase, rankingPointsTable, managerRankings, finalistManager } = await setupThroughSemifinals(
        TournamentId('t-finalist'),
      );

      await useCase.execute({
        matchId: MatchId('final'),
        tournamentId: TournamentId('t-finalist'),
        roundNumber: 4,
        matchIndex: 0,
      });

      const finalistRanking = await managerRankings.findById(finalistManager);
      expect(finalistRanking?.totalPoints).toBe(rankingPointsTable.pointsFor('challenger', 3));
    });

    it('awards the champion pointsFor(tier, 4)', async () => {
      const { useCase, rankingPointsTable, managerRankings, championManager } = await setupThroughSemifinals(
        TournamentId('t-champion'),
      );

      await useCase.execute({
        matchId: MatchId('final'),
        tournamentId: TournamentId('t-champion'),
        roundNumber: 4,
        matchIndex: 0,
      });

      const championRanking = await managerRankings.findById(championManager);
      expect(championRanking?.totalPoints).toBe(rankingPointsTable.pointsFor('challenger', 4));
    });
  });
});
