import { describe, expect, it } from 'vitest';
import {
  GameWorld,
  ManagerId,
  Player,
  PlayerId,
  RandomSource,
  StandardAgingPolicy,
  StandardPlayerGenerationPolicy,
  Tournament,
  TournamentId,
  WorldId,
  juniorEligibilityForAge,
} from '@tennis-manager/domain';
import {
  EventPublisherPort,
  GameWorldRepository,
  IdGeneratorPort,
  PlayerRepository,
  TournamentRepository,
} from '../ports/ports';
import {
  EnsureFillOnlyPopulationUseCase,
  FILL_DEMAND_HEADROOM_FACTOR,
  FILL_ONLY_FLOORS,
} from './EnsureFillOnlyPopulationUseCase';

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
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

  async findFreeAgents(): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === null && !p.isRetired());
  }

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }

  all(): Player[] {
    return [...this.store.values()];
  }
}

class InMemoryTournamentRepository implements TournamentRepository {
  private readonly store = new Map<string, Tournament>();
  /** Test-settable: ids the fake reports as holding an unfinished
   * commitment (the demand pass must not count them as available). */
  committedIds: PlayerId[] = [];

  async findUnfinishedCommitmentPlayerIds(): Promise<PlayerId[]> {
    return this.committedIds;
  }

  async findById(id: TournamentId): Promise<Tournament | null> {
    return this.store.get(id) ?? null;
  }

  async findOpenForRegistration(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => !t.hasStarted && !t.isCancelled);
  }

  async findStarted(): Promise<Tournament[]> {
    return [...this.store.values()].filter((t) => t.hasStarted);
  }

  async findByPlayerAndWeek(): Promise<Tournament[]> {
    return [];
  }

  async findDoublesByPlayerAndWeek(): Promise<Tournament[]> {
    return [];
  }

  async save(tournament: Tournament): Promise<void> {
    this.store.set(tournament.id, tournament);
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
  }
}

class SequentialIdGenerator implements IdGeneratorPort {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    return `filler-${this.counter}`;
  }
}

const realRandom: RandomSource = { next: () => Math.random() };
const agingPolicy = new StandardAgingPolicy();
const generationPolicy = new StandardPlayerGenerationPolicy();

function makeFiller(id: string, ageInWeeks: number): Player {
  const g = generationPolicy.generate(realRandom, { minWeeks: ageInWeeks, maxWeeks: ageInWeeks });
  return Player.generateFillOnly(
    PlayerId(id),
    `Filler ${id}`,
    g.ageInWeeks,
    agingPolicy.stageForAge(g.ageInWeeks),
    g.attributes,
    'US',
    g.potentialCeiling,
    g.physicalCeilings,
    g.talent,
  );
}

async function setup(worldId: WorldId = WorldId('main')) {
  const worlds = new InMemoryGameWorldRepository();
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  const tournaments = new InMemoryTournamentRepository();
  await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  const useCase = new EnsureFillOnlyPopulationUseCase(
    worlds,
    players,
    events,
    generationPolicy,
    realRandom,
    new SequentialIdGenerator(),
    agingPolicy,
    tournaments,
  );
  return { worlds, players, events, tournaments, worldId, useCase };
}

/** The headroom target the pass should reach for a band with `demand`
 * scheduled slots — mirrors the production formula only as the test's
 * own expectation, never imported from the use case's internals. */
function demandTarget(demand: number, floor: number): number {
  return Math.max(floor, Math.ceil(demand * FILL_DEMAND_HEADROOM_FACTOR));
}

describe('EnsureFillOnlyPopulationUseCase', () => {
  it('generates the full floor when starting from zero, every one fillOnly with no manager', async () => {
    const { players, worldId, useCase } = await setup();
    const totalFloor = FILL_ONLY_FLOORS.reduce((sum, f) => sum + f.minimum, 0);

    const result = await useCase.execute({ worldId });

    expect(result.generated).toBe(totalFloor);
    expect(players.all()).toHaveLength(totalFloor);
    expect(players.all().every((p) => p.fillOnly)).toBe(true);
    expect(players.all().every((p) => p.managerId === null)).toBe(true);
  });

  it('meets each band floor and every generated age maps into its band', async () => {
    const { players, worldId, useCase } = await setup();
    await useCase.execute({ worldId });

    const byBand = new Map<string, number>();
    for (const p of players.all()) {
      const band = juniorEligibilityForAge(p.seasonAgeAnchorWeeks);
      byBand.set(band, (byBand.get(band) ?? 0) + 1);
    }
    for (const floor of FILL_ONLY_FLOORS) {
      expect(byBand.get(floor.band) ?? 0).toBeGreaterThanOrEqual(floor.minimum);
    }
  });

  it('is idempotent — a re-run generates nothing once floors are met', async () => {
    const { players, worldId, useCase } = await setup();
    await useCase.execute({ worldId });
    const firstCount = players.all().length;

    const second = await useCase.execute({ worldId });

    expect(second.generated).toBe(0);
    expect(players.all().length).toBe(firstCount);
  });

  it('only generates the SHORTFALL, not the whole floor, when a band is partially populated', async () => {
    const { players, worldId, useCase } = await setup();
    for (let i = 0; i < 10; i++) {
      await players.save(makeFiller(`existing-${i}`, 25 * 52)); // 10 senior-age fillers
    }

    const result = await useCase.execute({ worldId });

    // 10 seniors already exist -> senior shortfall is 200 - 10 = 190;
    // the u18 (40), u16 (40), and u14 (10) bands still generate their
    // full floor. Looked up by band name, not array index, so this
    // doesn't silently drift if FILL_ONLY_FLOORS' order ever changes.
    const seniorFloor = FILL_ONLY_FLOORS.find((f) => f.band === 'senior')!.minimum;
    const otherFloors = FILL_ONLY_FLOORS.filter((f) => f.band !== 'senior').reduce((sum, f) => sum + f.minimum, 0);
    const expected = seniorFloor - 10 + otherFloors;
    expect(result.generated).toBe(expected);
  });

  it('tops the pool up to the NEXT week\'s measured demand — main-draw capacity plus the whole qualifying field, per band', async () => {
    const { players, tournaments, worldId, useCase } = await setup();
    const week = { season: 1, week: 2 }; // world is at week 1, so this is "next week"

    // Senior slate: a major week (128 draw, 8 qualifier + 2 wild-card
    // places reserved, 32-player qualifying), a tour (64, same shape),
    // and a futures (32, no qualifying). Demand = (128-8-2+32) + (64-8-2+32) + 32 = 268.
    await tournaments.save(Tournament.open({ name: 'Demand Major', id: TournamentId('demand-major'), tier: 'major', surface: 'hard', weekScheduled: week, drawSize: 128, qualifyingDrawSize: 32, qualifierSlots: 8, wildCardSlots: 2 }));
    await tournaments.save(Tournament.open({ name: 'Demand Tour', id: TournamentId('demand-tour'), tier: 'tour', surface: 'hard', weekScheduled: week, drawSize: 64, qualifyingDrawSize: 32, qualifierSlots: 8, wildCardSlots: 2 }));
    await tournaments.save(Tournament.open({ name: 'Demand Futures', id: TournamentId('demand-futures'), tier: 'futures', surface: 'hard', weekScheduled: week, drawSize: 32 }));
    // Junior: a u16 j30 slate (4 x 16 = 64) and a u18 j100 (32). Both
    // exceed their static floor, so the demand drive is actually visible.
    for (let i = 0; i < 4; i++) {
      await tournaments.save(Tournament.open({ name: `Demand J30 ${i}`, id: TournamentId(`demand-j30-${i}`), tier: 'j30', ageBand: 'u16', surface: 'hard', weekScheduled: week, drawSize: 16 }));
    }
    await tournaments.save(Tournament.open({ name: 'Demand J100', id: TournamentId('demand-j100'), tier: 'j100', ageBand: 'u18', surface: 'hard', weekScheduled: week, drawSize: 32 }));
    // A DIFFERENT week must not contribute.
    await tournaments.save(Tournament.open({ name: 'Far Major', id: TournamentId('demand-far'), tier: 'major', surface: 'hard', weekScheduled: { season: 1, week: 5 }, drawSize: 128, qualifyingDrawSize: 32, qualifierSlots: 8, wildCardSlots: 2 }));

    const result = await useCase.execute({ worldId });

    const seniorFloor = FILL_ONLY_FLOORS.find((f) => f.band === 'senior')!.minimum;
    const u18Floor = FILL_ONLY_FLOORS.find((f) => f.band === 'u18')!.minimum;
    const u16Floor = FILL_ONLY_FLOORS.find((f) => f.band === 'u16')!.minimum;
    const u14Floor = FILL_ONLY_FLOORS.find((f) => f.band === 'u14')!.minimum;
    const expected =
      demandTarget(268, seniorFloor) +
      demandTarget(32, u18Floor) +
      demandTarget(64, u16Floor) +
      u14Floor; // no u14 slate this week -> its floor
    expect(result.generated).toBe(expected);

    // The generated population lands in the right bands — counted by the
    // same eligibility age the fill consumer uses.
    const byBand = new Map<string, number>();
    for (const p of players.all()) {
      const band = juniorEligibilityForAge(p.seasonAgeAnchorWeeks);
      byBand.set(band, (byBand.get(band) ?? 0) + 1);
    }
    expect(byBand.get('senior')).toBe(demandTarget(268, seniorFloor));
    expect(byBand.get('u16')).toBe(demandTarget(64, u16Floor));
    expect(byBand.get('u18')).toBe(demandTarget(32, u18Floor));
    expect(byBand.get('u14')).toBe(u14Floor);
  });

  it('generates only the SHORTFALL between the demand target and the existing population', async () => {
    const { players, tournaments, worldId, useCase } = await setup();
    for (let i = 0; i < 10; i++) {
      await players.save(makeFiller(`demand-existing-${i}`, 25 * 52)); // 10 senior-age fillers
    }
    await tournaments.save(Tournament.open({ name: 'One Futures', id: TournamentId('shortfall-futures'), tier: 'futures', surface: 'hard', weekScheduled: { season: 1, week: 2 }, drawSize: 32 }));

    const result = await useCase.execute({ worldId });

    // Senior demand 32 -> target ceil(32 * 1.3) = 42; 10 already exist -> 32.
    const seniorFloor = FILL_ONLY_FLOORS.find((f) => f.band === 'senior')!.minimum;
    const otherFloors = FILL_ONLY_FLOORS.filter((f) => f.band !== 'senior').reduce((sum, f) => sum + f.minimum, 0);
    expect(result.generated).toBe(demandTarget(32, seniorFloor) - 10 + otherFloors);
    expect(players.all().filter((p) => juniorEligibilityForAge(p.seasonAgeAnchorWeeks) === 'senior').length).toBe(
      demandTarget(32, seniorFloor),
    );
  });

  it('does not count a filler still committed to an unfinished draw toward the target', async () => {
    // The pilot bug this pins: a pool whose members are mid-draw at the
    // rollover reported the target satisfied and generated nothing, so
    // the due draws starved. Only AVAILABLE fillers may count.
    const { players, tournaments, worldId, useCase } = await setup();
    const existingIds: PlayerId[] = [];
    for (let i = 0; i < 10; i++) {
      const player = makeFiller(`committed-existing-${i}`, 25 * 52);
      existingIds.push(player.id);
      await players.save(player);
    }
    // 8 of the 10 are locked in an unfinished draw.
    tournaments.committedIds = existingIds.slice(0, 8);
    await tournaments.save(Tournament.open({ name: 'One Futures', id: TournamentId('committed-futures'), tier: 'futures', surface: 'hard', weekScheduled: { season: 1, week: 2 }, drawSize: 32 }));

    const result = await useCase.execute({ worldId });

    // Senior target = ceil(32 * 1.3) = 42; only 2 of the 10 count, so 40
    // fresh players are generated instead of 32 (which counting all 10
    // would have produced).
    const seniorFloor = FILL_ONLY_FLOORS.find((f) => f.band === 'senior')!.minimum;
    const otherFloors = FILL_ONLY_FLOORS.filter((f) => f.band !== 'senior').reduce((sum, f) => sum + f.minimum, 0);
    expect(result.generated).toBe(demandTarget(32, seniorFloor) - 2 + otherFloors);
  });

  it('is idempotent with a demand target too — a re-run generates nothing', async () => {
    const { tournaments, players, worldId, useCase } = await setup();
    await tournaments.save(Tournament.open({ name: 'Idem Futures', id: TournamentId('idem-futures'), tier: 'futures', surface: 'hard', weekScheduled: { season: 1, week: 2 }, drawSize: 32 }));

    const first = await useCase.execute({ worldId });
    const afterFirst = players.all().length;
    const second = await useCase.execute({ worldId });

    expect(first.generated).toBeGreaterThan(0);
    expect(second.generated).toBe(0);
    expect(players.all().length).toBe(afterFirst);
  });

  it('throws when the target game world does not exist', async () => {
    const { useCase } = await setup();

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});
