import { describe, expect, it } from 'vitest';
import { TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';
import { OpenRegistrationUseCase } from './OpenRegistrationUseCase';

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

describe('OpenRegistrationUseCase', () => {
  it('creates an unstarted tournament with no entrants, listed via findOpenForRegistration', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new OpenRegistrationUseCase(tournaments);
    const tournamentId = TournamentId('t1');

    await useCase.execute({
      tournamentId,
      tier: 'futures',
      surface: 'hard',
      weekScheduled: { season: 2, week: 10 },
      drawSize: 16,
    });

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.hasStarted).toBe(false);
    expect(saved!.entrants).toHaveLength(0);
    expect(saved!.tier).toBe('futures');
    expect(saved!.surface).toBe('hard');

    expect(await tournaments.findOpenForRegistration()).toHaveLength(1);
    expect(await tournaments.findStarted()).toHaveLength(0);
  });
});
