import { describe, expect, it } from 'vitest';
import { GameWeek, GameWorld, PlayerId, RandomSource, Tournament, TournamentId, TournamentNameGenerator, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, IdGeneratorPort, TournamentRepository } from '../ports/ports';
import { OpenRegistrationUseCase } from './OpenRegistrationUseCase';
import { GenerateSeniorTournamentsUseCase } from './GenerateSeniorTournamentsUseCase';

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
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

  async findDoublesByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [];
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

class SequentialIdGenerator implements IdGeneratorPort {
  private n = 0;
  generate(): string {
    this.n += 1;
    return `senior-id-${this.n}`;
  }
}

const worldId = WorldId('main');

async function setup(week: GameWeek) {
  const worlds = new InMemoryGameWorldRepository();
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: week, lastAppliedTick: null }));
  const tournaments = new InMemoryTournamentRepository();
  const nameGenerator = new TournamentNameGenerator();
  const nameRandom: RandomSource = { next: () => 0 };
  const openRegistration = new OpenRegistrationUseCase(tournaments, nameGenerator, nameRandom);
  const useCase = new GenerateSeniorTournamentsUseCase(worlds, tournaments, openRegistration, new SequentialIdGenerator());
  return { worlds, tournaments, useCase };
}

describe('GenerateSeniorTournamentsUseCase', () => {
  it('opens the real StandardSeniorTournamentSchedulePolicy tiers for a typical (non-major) week — senior tour only, no age band', async () => {
    // 1*52 + 1 = 53 -> odd, not divisible by 13 (no major this week).
    const { tournaments, useCase } = await setup({ season: 1, week: 1 });

    const result = await useCase.execute({ worldId });

    const open = await tournaments.findOpenForRegistration();
    const byTier = new Map<string, number>();
    for (const t of open) {
      byTier.set(t.tier, (byTier.get(t.tier) ?? 0) + 1);
      // Every generated tournament is senior (ageBand null) and open.
      expect(t.ageBand).toBeNull();
      expect(t.hasStarted).toBe(false);
      expect(t.entrants).toHaveLength(0);
    }

    expect(byTier.get('futures')).toBe(2);
    expect(byTier.get('challenger')).toBe(2);
    expect(byTier.get('tour')).toBe(1);
    expect(byTier.has('major')).toBe(false);

    expect(result.opened).toBe(5);
    expect(open).toHaveLength(5);
  });

  it('adds a 128-draw major on its every-13-week cadence, on top of the weekly futures/challenger/tour', async () => {
    // 1*52 + 13 = 65 -> divisible by 13 (major week).
    const { tournaments, useCase } = await setup({ season: 1, week: 13 });

    await useCase.execute({ worldId });

    const open = await tournaments.findOpenForRegistration();
    const major = open.find((t) => t.tier === 'major');
    expect(major).toBeDefined();
    expect(major!.drawSize).toBe(128);
    expect(major!.ageBand).toBeNull();
    expect(open.filter((t) => t.tier === 'futures')).toHaveLength(2);
    expect(open.filter((t) => t.tier === 'challenger')).toHaveLength(2);
    expect(open.filter((t) => t.tier === 'tour')).toHaveLength(1);
  });

  it('honors an explicit week override (the season-backfill path) instead of the world clock', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 1 });

    // World is week 1; generate for a FUTURE week 40 regardless.
    const result = await useCase.execute({ worldId, week: { season: 1, week: 40 } });

    expect(result.opened).toBe(5);
    const open = await tournaments.findOpenForRegistration();
    expect(open).toHaveLength(5);
    for (const t of open) {
      expect(t.weekScheduled).toEqual({ season: 1, week: 40 });
    }
  });

  it('is idempotent: a re-fire with the same week opens nothing new', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 1 });

    const first = await useCase.execute({ worldId });
    const second = await useCase.execute({ worldId });

    expect(first.opened).toBe(5);
    expect(second.opened).toBe(0);
    expect(await tournaments.findOpenForRegistration()).toHaveLength(5);
  });

  it('reuses the same surface rotation across a full season so the slate is varied, not monotonous', async () => {
    const { tournaments, useCase } = await setup({ season: 1, week: 1 });
    await useCase.execute({ worldId });

    const surfaces = new Set((await tournaments.findOpenForRegistration()).map((t) => t.surface));
    // 5 tournaments across a 4-surface rotation -> at least 2 distinct surfaces.
    expect(surfaces.size).toBeGreaterThan(1);
  });
});
