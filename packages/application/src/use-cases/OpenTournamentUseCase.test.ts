import { describe, expect, it } from 'vitest';
import { GameWeek, PlayerId, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { TournamentEntrant } from '@tennis-manager/domain';
import { RandomSource, TournamentNameGenerator } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';
import { OpenTournamentUseCase } from './OpenTournamentUseCase';

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

function entrant(seed: number, id: string): TournamentEntrant {
  return { playerId: PlayerId(id), seed };
}

describe('OpenTournamentUseCase', () => {
  it('registers every entrant and seeds a full draw', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new OpenTournamentUseCase(tournaments, new BracketGenerator(), new TournamentNameGenerator(), new NullRandomSource());
    const tournamentId = TournamentId('t-1');

    await useCase.execute({
      tournamentId,
      tier: 'challenger',
      surface: 'clay',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
      entrants: Array.from({ length: 16 }, (_, i) => entrant(i + 1, `p${i + 1}`)),
    });

    const saved = await tournaments.findById(tournamentId);
    expect(saved).not.toBeNull();
    // The command never included a `name` field — this proves it was
    // generated internally by TournamentNameGenerator, not left blank.
    expect(saved!.name.trim().length).toBeGreaterThan(0);
    expect(saved!.entrants).toHaveLength(16);
    expect(saved!.hasStarted).toBe(true);
    expect(saved!.getRounds()).toHaveLength(1);
    expect(saved!.getRounds()[0].matches).toHaveLength(8);
    expect(saved!.getScheduledMatch(1, 0)).toEqual({
      entrantA: PlayerId('p1'),
      entrantB: PlayerId('p16'),
    });
  });

  it('registers byed entrants without giving them a round-1 match', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new OpenTournamentUseCase(tournaments, new BracketGenerator(), new TournamentNameGenerator(), new NullRandomSource());
    const tournamentId = TournamentId('t-2');

    await useCase.execute({
      tournamentId,
      tier: 'futures',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
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
