import { describe, expect, it } from 'vitest';
import { ManagerId, MatchId, PlayerId, TournamentId } from '../../../domain/src/shared/ids';
import { Player } from '../../../domain/src/player/Player';
import { PlayerAttributes, Skill, SurfaceAffinities } from '../../../domain/src/player/PlayerAttributes';
import { Tournament } from '../../../domain/src/competition/Tournament';
import { BracketGenerator } from '../../../domain/src/competition/BracketGenerator';
import { DrawSize, MatchLog } from '../../../domain/src/competition/CompetitionTypes';
import { MatchParticipant, MatchSimulator, SimulatedMatch } from '../../../domain/src/match-simulation/MatchSimulator';
import { Surface } from '../../../domain/src/player/PlayerAttributes';
import { EventPublisherPort, MatchLogStorePort, PlayerRepository, TournamentRepository } from '../ports/ports';
import { SimulateMatchUseCase } from './SimulateMatchUseCase';

class InMemoryTournamentRepository implements TournamentRepository {
  private readonly store = new Map<TournamentId, Tournament>();

  async findById(id: TournamentId): Promise<Tournament | null> {
    return this.store.get(id) ?? null;
  }

  async findOpenForRegistration(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => !t.hasStarted);
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
      log: { entries: [], totalDurationSeconds: 0 },
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

function makePlayer(id: PlayerId): Player {
  return Player.hire(id, id, 20 * 52, startingAttributes(), ManagerId('m1'));
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
    );

    await useCase.execute({ matchId: MatchId('final'), tournamentId, roundNumber: 4, matchIndex: 0 });

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.getRounds()).toHaveLength(4); // no round 5 — nothing further to generate
    expect(events.published.some((e) => e.type === 'TournamentCompleted')).toBe(true);
  });
});
