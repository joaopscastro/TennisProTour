import { describe, expect, it } from 'vitest';
import { GameWeek, GameWorld, PlayerId, Tournament, TournamentId, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, TournamentRepository } from '../ports/ports';
import { PlayerEntryPlannerQuery } from './PlayerEntryPlannerQuery';

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

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

const worldId = WorldId('main');

function openTournament(id: string, weekScheduled: GameWeek): Tournament {
  return Tournament.open({
    id: TournamentId(id),
    name: 'Test Championship',
    tier: 'challenger',
    surface: 'hard',
    weekScheduled,
    drawSize: 16,
  });
}

describe('PlayerEntryPlannerQuery', () => {
  it('returns one entry per week in the window, defaulting to the world current week through weeksAhead-1 weeks later', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
    const query = new PlayerEntryPlannerQuery(tournaments, worlds);
    const player = PlayerId('p1');

    const result = await query.forPlayer(worldId, player, 4);

    expect(result).toHaveLength(4);
    expect(result.map((r) => r.week)).toEqual([
      { season: 1, week: 1 },
      { season: 1, week: 2 },
      { season: 1, week: 3 },
      { season: 1, week: 4 },
    ]);
    // No registrations anywhere — every week reports an explicit empty
    // list, not an error or a missing entry.
    for (const r of result) expect(r.entries).toEqual([]);
  });

  it('shows a real entry in the correct week, and nothing in weeks the player has no entry — the exact multi-week planner scenario', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
    const query = new PlayerEntryPlannerQuery(tournaments, worlds);
    const player = PlayerId('p1');

    // Registered into week 2 and week 4 only — week 1 and week 3 stay empty.
    const week2 = openTournament('t-week2', { season: 1, week: 2 });
    week2.registerEntrant({ playerId: player, seed: null });
    await tournaments.save(week2);

    const week4 = openTournament('t-week4', { season: 1, week: 4 });
    week4.registerEntrant({ playerId: player, seed: null });
    await tournaments.save(week4);

    const result = await query.forPlayer(worldId, player, 5);

    expect(result[0].entries).toEqual([]); // week 1
    expect(result[1].entries.map((t) => t.id)).toEqual([TournamentId('t-week2')]); // week 2
    expect(result[2].entries).toEqual([]); // week 3
    expect(result[3].entries.map((t) => t.id)).toEqual([TournamentId('t-week4')]); // week 4
    expect(result[4].entries).toEqual([]); // week 5
  });

  it('does not include another player\'s entry', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, lastAppliedTick: null }));
    const query = new PlayerEntryPlannerQuery(tournaments, worlds);

    const week1 = openTournament('t-other', { season: 1, week: 1 });
    week1.registerEntrant({ playerId: PlayerId('someone-else'), seed: null });
    await tournaments.save(week1);

    const result = await query.forPlayer(worldId, PlayerId('p1'), 2);
    expect(result[0].entries).toEqual([]);
  });

  it('rolls across a season boundary correctly (reuses addWeeks)', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const worlds = new InMemoryGameWorldRepository();
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 51 }, lastAppliedTick: null }));
    const query = new PlayerEntryPlannerQuery(tournaments, worlds);

    const result = await query.forPlayer(worldId, PlayerId('p1'), 4);
    expect(result.map((r) => r.week)).toEqual([
      { season: 1, week: 51 },
      { season: 1, week: 52 },
      { season: 2, week: 1 },
      { season: 2, week: 2 },
    ]);
  });

  it('throws for an unknown world, same as other queries', async () => {
    const tournaments = new InMemoryTournamentRepository();
    const worlds = new InMemoryGameWorldRepository();
    const query = new PlayerEntryPlannerQuery(tournaments, worlds);
    await expect(query.forPlayer(WorldId('nope'), PlayerId('p1'))).rejects.toThrow(/not found/);
  });
});
