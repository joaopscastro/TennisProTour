import { describe, expect, it } from 'vitest';
import { GameWeek, PlayerId, TournamentId } from '@tennis-manager/domain';
import { Tournament } from '@tennis-manager/domain';
import { BracketGenerator } from '@tennis-manager/domain';
import { TournamentRepository } from '../ports/ports';
import { JUNIOR_WEEKLY_ENTRY_CAP } from './juniorEntryCap';
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

function openJuniorTournament(id: TournamentId, weekScheduled: GameWeek = { season: 1, week: 1 }): Tournament {
  return Tournament.open({
    id,
    tier: 'j100',
    ageBand: 'u14',
    surface: 'clay',
    weekScheduled,
    drawSize: 16,
  });
}

function openTournament(id: TournamentId, weekScheduled: GameWeek = { season: 1, week: 1 }): Tournament {
  return Tournament.open({
    id,
    tier: 'challenger',
    surface: 'clay',
    weekScheduled,
    drawSize: 16,
  });
}

describe('RegisterEntrantUseCase', () => {
  it('registers a player into an already-open tournament and persists it', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournamentId = TournamentId('t1');
    await tournaments.save(openTournament(tournamentId));

    const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());
    await useCase.execute({ tournamentId, playerId: PlayerId('p1') });

    const saved = await tournaments.findById(tournamentId);
    expect(saved!.entrants).toEqual([{ playerId: PlayerId('p1'), seed: null }]);
  });

  it('throws when the tournament does not exist', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());

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

    const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());
    await expect(useCase.execute({ tournamentId, playerId: PlayerId('p17') })).rejects.toThrow(/already started/);
  });

  it('auto-starts the bracket the moment the last slot fills, and not before', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const tournamentId = TournamentId('t1');
    await tournaments.save(openTournament(tournamentId));

    const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());
    for (let i = 1; i <= 15; i++) {
      await useCase.execute({ tournamentId, playerId: PlayerId(`p${i}`), seed: i });
      expect((await tournaments.findById(tournamentId))!.hasStarted).toBe(false);
    }

    await useCase.execute({ tournamentId, playerId: PlayerId('p16'), seed: 16 });

    const started = await tournaments.findById(tournamentId);
    expect(started!.hasStarted).toBe(true);
    expect(started!.entrants).toHaveLength(16);
    expect(started!.getRounds()).toHaveLength(1);
    expect(started!.getRounds()[0].matches).toHaveLength(8);
  });

  describe('junior weekly entry cap', () => {
    it(`rejects registering a player into a ${JUNIOR_WEEKLY_ENTRY_CAP + 1}th junior tournament in the same GameWeek`, async () => {
      const tournaments = new InMemoryTournamentRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('junior-player');
      const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());

      // Fill up the cap first.
      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`j${i}`);
        await tournaments.save(openJuniorTournament(id, week));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // One more, same week, must be rejected.
      const oneTooMany = TournamentId('j-over-cap');
      await tournaments.save(openJuniorTournament(oneTooMany, week));

      await expect(useCase.execute({ tournamentId: oneTooMany, playerId: player })).rejects.toThrow(
        new RegExp(`already entered ${JUNIOR_WEEKLY_ENTRY_CAP} junior tournaments`),
      );

      // The rejected registration must not have partially applied.
      const rejected = await tournaments.findById(oneTooMany);
      expect(rejected!.entrants).toHaveLength(0);
    });

    it('allows entering junior tournaments up to the cap, and allows a different player unaffected by another player’s count', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('junior-player');
      const otherPlayer = PlayerId('another-junior-player');
      const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());

      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`j${i}`);
        await tournaments.save(openJuniorTournament(id, week));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // A different tournament, different player, same week — must not
      // be blocked by `player`'s cap.
      const otherTournamentId = TournamentId('j-other-player');
      await tournaments.save(openJuniorTournament(otherTournamentId, week));
      await expect(
        useCase.execute({ tournamentId: otherTournamentId, playerId: otherPlayer }),
      ).resolves.toBeUndefined();
    });

    it('does not count a junior entry from a different GameWeek against the cap', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const week1: GameWeek = { season: 1, week: 1 };
      const week2: GameWeek = { season: 1, week: 2 };
      const player = PlayerId('junior-player');
      const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());

      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`week1-j${i}`);
        await tournaments.save(openJuniorTournament(id, week1));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // A new week resets the cap.
      const nextWeekTournament = TournamentId('week2-j1');
      await tournaments.save(openJuniorTournament(nextWeekTournament, week2));
      await expect(
        useCase.execute({ tournamentId: nextWeekTournament, playerId: player }),
      ).resolves.toBeUndefined();
    });

    it('does not apply the junior cap to senior-tier registration — a player may enter more than the junior cap worth of senior tournaments in one week', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('senior-player');
      const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());

      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP + 2; i++) {
        const id = TournamentId(`senior${i}`);
        await tournaments.save(openTournament(id, week));
        await expect(useCase.execute({ tournamentId: id, playerId: player })).resolves.toBeUndefined();
      }

      const registrations = await tournaments.findByPlayerAndWeek(player, week);
      expect(registrations).toHaveLength(JUNIOR_WEEKLY_ENTRY_CAP + 2);
    });

    it('does not let a senior registration count against, or be blocked by, a junior weekly count', async () => {
      const tournaments = new InMemoryTournamentRepository();
      const week: GameWeek = { season: 1, week: 1 };
      const player = PlayerId('mixed-player');
      const useCase = new RegisterEntrantUseCase(tournaments, new BracketGenerator());

      for (let i = 1; i <= JUNIOR_WEEKLY_ENTRY_CAP; i++) {
        const id = TournamentId(`j${i}`);
        await tournaments.save(openJuniorTournament(id, week));
        await useCase.execute({ tournamentId: id, playerId: player });
      }

      // Already at the junior cap for the week — a senior-tier entry
      // the same week must still succeed.
      const seniorId = TournamentId('senior-same-week');
      await tournaments.save(openTournament(seniorId, week));
      await expect(useCase.execute({ tournamentId: seniorId, playerId: player })).resolves.toBeUndefined();
    });
  });
});
