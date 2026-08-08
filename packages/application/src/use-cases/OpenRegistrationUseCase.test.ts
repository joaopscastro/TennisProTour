import { describe, expect, it } from 'vitest';
import { GameWeek, PlayerId, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { RandomSource, TournamentNameGenerator } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';
import { OpenRegistrationUseCase } from './OpenRegistrationUseCase';

class NullRandomSource implements RandomSource {
  next(): number {
    return 0;
  }
}

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

describe('OpenRegistrationUseCase', () => {
  it('creates an unstarted tournament with no entrants, listed via findOpenForRegistration', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new OpenRegistrationUseCase(tournaments, new TournamentNameGenerator(), new NullRandomSource());
    const tournamentId = TournamentId('t1');

    await useCase.execute({
      tournamentId,
      tier: 'futures',
      surface: 'hard',
      weekScheduled: { season: 2, week: 10 },
      drawSize: 16,
    });

    const saved = await tournaments.findById(tournamentId);
    // The command never included a `name` field — this proves it was
    // generated internally by TournamentNameGenerator, not left blank.
    expect(saved!.name.trim().length).toBeGreaterThan(0);
    expect(saved!.hasStarted).toBe(false);
    expect(saved!.entrants).toHaveLength(0);
    expect(saved!.tier).toBe('futures');
    expect(saved!.surface).toBe('hard');

    expect(await tournaments.findOpenForRegistration()).toHaveLength(1);
    expect(await tournaments.findStarted()).toHaveLength(0);
  });
});
