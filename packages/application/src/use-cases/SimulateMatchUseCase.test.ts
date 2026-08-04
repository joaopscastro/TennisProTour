import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerRanking, MatchId, PlayerId, TournamentId } from '@tennis-manager/domain';
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
  PlayerRankingRepository,
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

class InMemoryPlayerRankingRepository implements PlayerRankingRepository {
  private readonly store = new Map<PlayerId, PlayerRanking>();

  async findById(playerId: PlayerId): Promise<PlayerRanking | null> {
    return this.store.get(playerId) ?? null;
  }

  async save(ranking: PlayerRanking): Promise<void> {
    this.store.set(ranking.playerId, ranking);
  }

  async findAllSortedByPoints(): Promise<PlayerRanking[]> {
    return [...this.store.values()].sort((a, b) => b.totalPoints - a.totalPoints);
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
      new InMemoryPlayerRankingRepository(),
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
      new InMemoryPlayerRankingRepository(),
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
      const playerRankings = new InMemoryPlayerRankingRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        playerRankings,
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const loserRanking = await playerRankings.findById(firstMatch.entrantB);
      expect(loserRanking?.totalPoints).toBe(rankingPointsTable.pointsFor('challenger', 0));

      const winnerRanking = await playerRankings.findById(firstMatch.entrantA);
      expect(winnerRanking).toBeNull();
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
      const playerRankings = new InMemoryPlayerRankingRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        playerRankings,
      );

      await useCase.execute({ matchId: MatchId('m0'), tournamentId, roundNumber: 1, matchIndex: 0 });

      const loserRanking = await playerRankings.findById(firstMatch.entrantB);
      expect(loserRanking?.totalPoints).toBe(rankingPointsTable.pointsFor('challenger', 0));
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
      const playerRankings = new InMemoryPlayerRankingRepository();
      const useCase = new SimulateMatchUseCase(
        tournaments,
        players,
        new AlwaysAWinsSimulator(),
        new FakeMatchLogStore(),
        new RecordingEventPublisher(),
        bracketGenerator,
        rankingPointsTable,
        playerRankings,
      );

      await cascadeToRound(useCase, tournaments, tournamentId, 4);

      const finalTournament = (await tournaments.findById(tournamentId))!;
      const finalMatch = finalTournament.getRounds()[3].matches[0];
      // AlwaysAWinsSimulator always advances entrantA, so entrantA of
      // the final is the eventual champion and entrantB the runner-up.
      return {
        tournaments,
        useCase,
        rankingPointsTable,
        playerRankings,
        champion: finalMatch.entrantA,
        finalist: finalMatch.entrantB,
      };
    }

    it('awards a finalist (loses the final after winning 3 rounds) pointsFor(tier, 3)', async () => {
      const { useCase, rankingPointsTable, playerRankings, finalist } = await setupThroughSemifinals(
        TournamentId('t-finalist'),
      );

      await useCase.execute({
        matchId: MatchId('final'),
        tournamentId: TournamentId('t-finalist'),
        roundNumber: 4,
        matchIndex: 0,
      });

      const finalistRanking = await playerRankings.findById(finalist);
      expect(finalistRanking?.totalPoints).toBe(rankingPointsTable.pointsFor('challenger', 3));
    });

    it('awards the champion pointsFor(tier, 4)', async () => {
      const { useCase, rankingPointsTable, playerRankings, champion } = await setupThroughSemifinals(
        TournamentId('t-champion'),
      );

      await useCase.execute({
        matchId: MatchId('final'),
        tournamentId: TournamentId('t-champion'),
        roundNumber: 4,
        matchIndex: 0,
      });

      const championRanking = await playerRankings.findById(champion);
      expect(championRanking?.totalPoints).toBe(rankingPointsTable.pointsFor('challenger', 4));
    });

    it('findAllSortedByPoints ranks players by points descending — the source of rank position', async () => {
      const playerRankings = new InMemoryPlayerRankingRepository();
      const low = PlayerRanking.empty(PlayerId('low'));
      low.addPoints(10);
      const high = PlayerRanking.empty(PlayerId('high'));
      high.addPoints(90);
      const mid = PlayerRanking.empty(PlayerId('mid'));
      mid.addPoints(50);
      await playerRankings.save(low);
      await playerRankings.save(high);
      await playerRankings.save(mid);

      const sorted = await playerRankings.findAllSortedByPoints();

      expect(sorted.map((r) => r.playerId)).toEqual([PlayerId('high'), PlayerId('mid'), PlayerId('low')]);
    });
  });
});
