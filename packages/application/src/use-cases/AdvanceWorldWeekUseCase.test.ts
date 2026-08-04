import { describe, expect, it } from 'vitest';
import {
  AcceleratedDeclinePolicy,
  AgingPolicy,
  GameWorld,
  ManagerId,
  Player,
  PlayerAgingService,
  PlayerAttributes,
  PlayerId,
  PlayerLifecycleStage,
  Skill,
  StandardAgingPolicy,
  StandardTrainingPolicy,
  SurfaceAffinities,
  TrainingPolicy,
  WorldId,
} from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, GameWorldRepository, PlayerRepository } from '../ports/ports';
import { AdvanceWorldWeekUseCase } from './AdvanceWorldWeekUseCase';

/** Deterministic stand-in so training-application tests assert on a
 * known delta rather than StandardTrainingPolicy's real balance
 * numbers (same pattern as the aging tests' visibleDeclineBase). */
class FixedTrainingPolicy implements TrainingPolicy {
  constructor(private readonly delta: number) {}

  computeDelta(): number {
    return this.delta;
  }
}

class FakeBillingPort implements BillingPort {
  constructor(private readonly proManagers: Set<string> = new Set()) {}

  async isProSubscriber(managerId: ManagerId): Promise<boolean> {
    return this.proManagers.has(managerId);
  }

  async createProCheckoutSession(): Promise<{ url: string }> {
    return { url: 'https://checkout.test/session' };
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

class InMemoryPlayerRepository implements PlayerRepository {
  private readonly store = new Map<PlayerId, Player>();
  saveCount = 0;

  async findById(id: PlayerId): Promise<Player | null> {
    return this.store.get(id) ?? null;
  }

  async findByManager(managerId: ManagerId): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === managerId);
  }

  async findAll(): Promise<Player[]> {
    return [...this.store.values()];
  }

  async save(player: Player): Promise<void> {
    this.saveCount += 1;
    this.store.set(player.id, player);
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
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

async function setup(playerCount: number) {
  const worlds = new InMemoryGameWorldRepository();
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  const worldId = WorldId('main');
  await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  for (let i = 1; i <= playerCount; i++) {
    const player = Player.hire(PlayerId(`p${i}`), `Player ${i}`, 25 * 52, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    await players.save(player);
  }
  players.saveCount = 0;
  const standardAging = new PlayerAgingService(new StandardAgingPolicy());
  const useCase = new AdvanceWorldWeekUseCase(
    worlds,
    players,
    new FakeBillingPort(),
    standardAging,
    standardAging,
    events,
    new StandardTrainingPolicy(),
  );
  return { worlds, players, events, worldId, useCase };
}

describe('AdvanceWorldWeekUseCase', () => {
  it('advances the world one week and ages every player', async () => {
    const { worlds, players, worldId, useCase } = await setup(3);

    const result = await useCase.execute({ worldId, tickKey: '2026-W31' });

    expect(result).toEqual({ advanced: true, playersAged: 3 });
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 2 });
    for (const player of await players.findAll()) {
      expect(player.ageInWeeks).toBe(25 * 52 + 1);
    }
  });

  it('is a no-op when run twice for the same tick', async () => {
    const { worlds, players, worldId, useCase } = await setup(3);

    const first = await useCase.execute({ worldId, tickKey: '2026-W31' });
    const savesAfterFirst = players.saveCount;
    const second = await useCase.execute({ worldId, tickKey: '2026-W31' });

    expect(first.advanced).toBe(true);
    expect(second).toEqual({ advanced: false, playersAged: 0 });
    // No player was touched or saved again, and the clock stayed put.
    expect(players.saveCount).toBe(savesAfterFirst);
    for (const player of await players.findAll()) {
      expect(player.ageInWeeks).toBe(25 * 52 + 1);
    }
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 2 });
  });

  it('advances again for a NEW tick key (the guard is per-tick, not once-ever)', async () => {
    const { worlds, worldId, useCase } = await setup(1);

    await useCase.execute({ worldId, tickKey: '2026-W31' });
    const result = await useCase.execute({ worldId, tickKey: '2026-W32' });

    expect(result.advanced).toBe(true);
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 3 });
  });

  it('rolls the season over after week 52', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 52 }));
    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      new InMemoryPlayerRepository(),
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new StandardTrainingPolicy(),
    );

    await useCase.execute({ worldId, tickKey: 'tick' });

    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 2, week: 1 });
  });

  it('publishes PlayerRetired when the weekly advance tips a player into retirement', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const player = Player.hire(PlayerId('old'), 'Old Timer', 38 * 52 - 1, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    await players.save(player);
    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      events,
      new StandardTrainingPolicy(),
    );

    await useCase.execute({ worldId, tickKey: 'tick' });

    expect((await players.findById(PlayerId('old')))!.stage).toBe('retired');
    expect(events.published.some((e) => e.type === 'PlayerRetired')).toBe(true);
  });

  it('applies the Pro tradeoff: Pro-managed players decline faster than free-managed ones', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));

    // Base policy with a decline delta large enough to survive Skill's
    // integer rounding, so the multiplier's effect is observable.
    const visibleDeclineBase: AgingPolicy = {
      weeklyDeclineDelta: (stage: PlayerLifecycleStage) => (stage === 'decline' ? -2 : 0),
      stageForAge: () => 'decline',
      retirementAgeInWeeks: () => Number.MAX_SAFE_INTEGER,
    };
    const standardAging = new PlayerAgingService(visibleDeclineBase);
    const proAging = new PlayerAgingService(new AcceleratedDeclinePolicy(visibleDeclineBase, 2));

    const freePlayer = Player.hire(PlayerId('free-p'), 'Free P', 31 * 52, startingAttributes(), ManagerId('free-m'));
    const proPlayer = Player.hire(PlayerId('pro-p'), 'Pro P', 31 * 52, startingAttributes(), ManagerId('pro-m'));
    freePlayer.pullDomainEvents();
    proPlayer.pullDomainEvents();
    await players.save(freePlayer);
    await players.save(proPlayer);

    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(new Set(['pro-m'])),
      standardAging,
      proAging,
      new RecordingEventPublisher(),
      new StandardTrainingPolicy(),
    );

    await useCase.execute({ worldId, tickKey: 'tick' });

    // Both started at serve 30. Free: -2 -> 28. Pro: -2 * 2 -> 26.
    expect((await players.findById(PlayerId('free-p')))!.attributes.technical.serve.value).toBe(28);
    expect((await players.findById(PlayerId('pro-p')))!.attributes.technical.serve.value).toBe(26);
  });

  it('applies no training delta for a player with no standing focus', async () => {
    const { worlds, players, worldId, useCase } = await setup(1);

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const player = await players.findById(PlayerId('p1'));
    expect(player!.currentFocus).toBeNull();
    expect(player!.attributes.surfaceAffinities.get('clay')).toBe(20); // untouched
  });

  it('applies the standing training focus automatically on tick, with no separate use-case call', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const player = Player.hire(PlayerId('p1'), 'Player 1', 25 * 52, startingAttributes(), ManagerId('m1'));
    player.setTrainingFocus({ kind: 'surface', surface: 'grass' });
    player.pullDomainEvents();
    await players.save(player);

    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new FixedTrainingPolicy(6),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const trained = await players.findById(PlayerId('p1'));
    expect(trained!.attributes.surfaceAffinities.get('grass')).toBe(26); // 20 + 6
    expect(trained!.attributes.surfaceAffinities.get('clay')).toBe(20); // untouched

    // Changing the focus AFTER a tick has already run must not
    // retroactively affect that tick — only a future tick sees it.
    trained!.setTrainingFocus({ kind: 'surface', surface: 'clay' });
    await players.save(trained!);
    expect((await players.findById(PlayerId('p1')))!.attributes.surfaceAffinities.get('clay')).toBe(20);
  });

  it('does not double-apply training when the same tick is re-run (idempotent, like aging)', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const player = Player.hire(PlayerId('p1'), 'Player 1', 25 * 52, startingAttributes(), ManagerId('m1'));
    player.setTrainingFocus({ kind: 'skill', cluster: 'mental' });
    player.pullDomainEvents();
    await players.save(player);

    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new FixedTrainingPolicy(3),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });
    const second = await useCase.execute({ worldId, tickKey: 'tick-1' });

    expect(second).toEqual({ advanced: false, playersAged: 0 });
    expect((await players.findById(PlayerId('p1')))!.attributes.mental.clutch.value).toBe(33); // 30 + 3, not +6
  });
});
