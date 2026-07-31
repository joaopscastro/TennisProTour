import { describe, expect, it } from 'vitest';
import { asPlayerId, asTournamentId, GameWeek, TournamentId } from '../../../domain/src/shared/ids';
import { Tournament } from '../../../domain/src/competition/Tournament';
import { BracketGenerator } from '../../../domain/src/competition/BracketGenerator';
import { TournamentEntrant } from '../../../domain/src/competition/CompetitionTypes';
import { TournamentRepository } from '../ports/ports';
import { OpenTournamentUseCase } from './OpenTournamentUseCase';

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

function entrant(seed: number, id: string): TournamentEntrant {
  return { playerId: asPlayerId(id), seed };
}

describe('OpenTournamentUseCase', () => {
  it('registers every entrant and seeds a full draw', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new OpenTournamentUseCase(tournaments, new BracketGenerator());
    const tournamentId = asTournamentId('t-1');

    await useCase.execute({
      tournamentId,
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: GameWeek.of(1),
      drawSize: 16,
      entrants: Array.from({ length: 16 }, (_, i) => entrant(i + 1, `p${i + 1}`)),
    });

    const saved = await tournaments.findById(tournamentId);
    expect(saved).not.toBeNull();
    expect(saved!.entrants).toHaveLength(16);
    expect(saved!.hasStarted).toBe(true);
    expect(saved!.getRounds()).toHaveLength(1);
    expect(saved!.getRounds()[0].matches).toHaveLength(8);
    expect(saved!.getScheduledMatch(1, 0)).toEqual({
      entrantA: asPlayerId('p1'),
      entrantB: asPlayerId('p16'),
    });
  });

  it('registers byed entrants without giving them a round-1 match', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new OpenTournamentUseCase(tournaments, new BracketGenerator());
    const tournamentId = asTournamentId('t-2');

    await useCase.execute({
      tournamentId,
      tier: 'futures',
      surface: 'hard',
      weekScheduled: GameWeek.of(1),
      drawSize: 16,
      entrants: Array.from({ length: 10 }, (_, i) => entrant(i + 1, `p${i + 1}`)),
    });

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.entrants).toHaveLength(10);
    expect(saved!.getRounds()[0].matches).toHaveLength(2);

    const notInRepositoryAnymore = await tournaments.findOpenForRegistration();
    expect(notInRepositoryAnymore).toHaveLength(0);
  });
});
