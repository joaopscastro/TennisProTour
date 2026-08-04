import { describe, expect, it } from 'vitest';
import { PlayerId, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';
import { RegisterEntrantUseCase } from './RegisterEntrantUseCase';

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

function openTournament(id: TournamentId): Tournament {
  return Tournament.open({
    id,
    tier: 'challenger',
    surface: 'clay',
    weekScheduled: { season: 1, week: 1 },
    drawSize: 16,
  });
}

describe('RegisterEntrantUseCase', () => {
  it('registers a player into an already-open tournament and persists it', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournamentId = TournamentId('t1');
    await tournaments.save(openTournament(tournamentId));

    const useCase = new RegisterEntrantUseCase(tournaments);
    await useCase.execute({ tournamentId, playerId: PlayerId('p1') });

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.entrants).toEqual([{ playerId: PlayerId('p1'), seed: null }]);
  });

  it('throws when the tournament does not exist', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new RegisterEntrantUseCase(tournaments);

    await expect(useCase.execute({ tournamentId: TournamentId('ghost'), playerId: PlayerId('p1') })).rejects.toThrow(
      /not found/,
    );
  });

  it('throws when the tournament has already started (delegated to the aggregate)', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournamentId = TournamentId('t1');
    const tournament = openTournament(tournamentId);
    for (let i = 1; i <= 16; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: i });
    }
    const [round1] = new BracketGenerator().generate(tournament.entrants, 16);
    tournament.startWithBracket([round1]);
    await tournaments.save(tournament);

    const useCase = new RegisterEntrantUseCase(tournaments);
    await expect(useCase.execute({ tournamentId, playerId: PlayerId('p17') })).rejects.toThrow(/already started/);
  });
});
