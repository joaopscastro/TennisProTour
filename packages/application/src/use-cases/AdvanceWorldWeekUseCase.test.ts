import { describe, expect, it } from 'vitest';
import {
  AcceleratedDeclinePolicy,
  AgingPolicy,
  Coach,
  CoachId,
  GameWorld,
  GRADUATION_CARRYOVER_FRACTION,
  ManagerId,
  Player,
  PlayerAgingService,
  PlayerAttributes,
  PlayerId,
  PlayerLifecycleStage,
  RankingLedgerEntry,
  Skill,
  StandardAgingPolicy,
  StandardTrainingPolicy,
  SurfaceAffinities,
  TournamentId,
  TrainingPolicy,
  WorldId,
} from '@tennis-manager/domain';
import {
  BillingPort,
  CoachRepository,
  EventPublisherPort,
  GameWorldRepository,
  PlayerRepository,
  RankingLedgerRepository,
} from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { AdvanceWorldWeekUseCase } from './AdvanceWorldWeekUseCase';

class InMemoryRankingLedgerRepository implements RankingLedgerRepository {
  private readonly entries: RankingLedgerEntry[] = [];

  async append(entry: RankingLedgerEntry): Promise<void> {
    this.entries.push(entry);
  }

  async findByPlayer(playerId: PlayerId): Promise<RankingLedgerEntry[]> {
    return this.entries.filter((e) => e.playerId === playerId);
  }

  async findAll(): Promise<RankingLedgerEntry[]> {
    return [...this.entries];
  }
}

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

  async customPlayerCreditBalance(): Promise<number> {
    return 0;
  }

  async consumeCustomPlayerCredit(): Promise<boolean> {
    return false;
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

class InMemoryCoachRepository implements CoachRepository {
  private readonly store: Coach[] = [];

  async findByManager(managerId: ManagerId): Promise<Coach[]> {
    return this.store.filter((c) => c.managerId === managerId);
  }

  async save(coach: Coach): Promise<void> {
    this.store.push(coach);
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
  const coaches = new InMemoryCoachRepository();
  const useCase = new AdvanceWorldWeekUseCase(
    worlds,
    players,
    new FakeBillingPort(),
    standardAging,
    standardAging,
    events,
    new StandardTrainingPolicy(),
    coaches,
    new InMemoryRankingLedgerRepository(),
  );
  return { worlds, players, events, worldId, useCase, coaches };
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
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
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
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
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
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
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
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
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

  it('ages AND auto-trains a fillOnly free agent toward its weakest attribute every tick, with no manager, no currentFocus, and no coach involved', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    // Every attribute starts at 30 except backhand, deliberately lower
    // — the weakest one, so it's the one auto-training should target.
    const attributes = startingAttributes().trainedOnAttribute('backhand', -10); // 30 -> 20
    const fillOnly = Player.generateFillOnly(PlayerId('filler-1'), 'Filler One', 25 * 52, 'prime', attributes);
    fillOnly.pullDomainEvents();
    await players.save(fillOnly);

    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new FixedTrainingPolicy(6),
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const trained = await players.findById(PlayerId('filler-1'));
    // Aging happened exactly like any other non-retired player.
    expect(trained!.ageInWeeks).toBe(25 * 52 + 1);
    // The weakest attribute (backhand, 20) trained; nothing else did —
    // no currentFocus was ever set, and there was no manager/coach to
    // look up (FakeBillingPort/InMemoryCoachRepository never asked).
    expect(trained!.attributes.attributeValue('backhand')).toBe(26); // 20 + 6
    expect(trained!.attributes.attributeValue('serve')).toBe(30); // untouched
    expect(trained!.currentFocus).toBeNull();
    expect(trained!.managerId).toBeNull();
  });

  it('re-targets the fill-only auto-training focus as the weakest attribute changes week over week, instead of freezing on the first pick', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    // backhand (20) starts weakest; a single +6 session brings it to 26,
    // which ties speed/stamina/strength at their own starting 30 only
    // if nothing else changes — set stamina lower (18) so it becomes
    // the new weakest attribute on the SECOND tick, proving the focus
    // isn't just fixed once at generation time.
    let attributes = startingAttributes().trainedOnAttribute('backhand', -10); // 30 -> 20
    attributes = attributes.trainedOnAttribute('stamina', -12); // 30 -> 18
    const fillOnly = Player.generateFillOnly(PlayerId('filler-1'), 'Filler One', 25 * 52, 'prime', attributes);
    fillOnly.pullDomainEvents();
    await players.save(fillOnly);

    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new FixedTrainingPolicy(6),
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });
    let mid = await players.findById(PlayerId('filler-1'));
    expect(mid!.attributes.attributeValue('stamina')).toBe(24); // 18 + 6: this tick's weakest
    expect(mid!.attributes.attributeValue('backhand')).toBe(20); // untouched this tick

    await useCase.execute({ worldId, tickKey: 'tick-2' });
    const after = await players.findById(PlayerId('filler-1'));
    // backhand (20) is now the weakest, not stamina (24 after tick 1) —
    // confirms the target is recomputed fresh, not frozen from tick 1.
    expect(after!.attributes.attributeValue('backhand')).toBe(26); // 20 + 6
    expect(after!.attributes.attributeValue('stamina')).toBe(24); // untouched this tick
  });

  it('a fillOnly player that ages into retirement this same tick simply stops training, same as any other player', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const fillOnly = Player.generateFillOnly(PlayerId('filler-1'), 'Filler One', 38 * 52 - 1, 'decline', startingAttributes());
    fillOnly.pullDomainEvents();
    await players.save(fillOnly);

    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new FixedTrainingPolicy(6),
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const retired = await players.findById(PlayerId('filler-1'));
    expect(retired!.isRetired()).toBe(true);
    expect(retired!.attributes.attributeValue('serve')).toBe(30); // no training delta applied
  });

  it('does not double-apply training when the same tick is re-run (idempotent, like aging)', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
    const player = Player.hire(PlayerId('p1'), 'Player 1', 25 * 52, startingAttributes(), ManagerId('m1'));
    player.setTrainingFocus({ kind: 'attribute', attribute: 'serve' });
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
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });
    const second = await useCase.execute({ worldId, tickKey: 'tick-1' });

    expect(second).toEqual({ advanced: false, playersAged: 0 });
    expect((await players.findById(PlayerId('p1')))!.attributes.technical.serve.value).toBe(33); // 30 + 3, not +6
  });

  it("boosts a player's weekly training by their manager's coach, and leaves a coachless manager's players unboosted", async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));

    const coachedManager = ManagerId('coached-m');
    const uncoachedManager = ManagerId('uncoached-m');
    const coachedPlayer = Player.hire(PlayerId('coached-p'), 'Coached', 25 * 52, startingAttributes(), coachedManager);
    coachedPlayer.setTrainingFocus({ kind: 'surface', surface: 'grass' });
    coachedPlayer.pullDomainEvents();
    await players.save(coachedPlayer);
    const uncoachedPlayer = Player.hire(PlayerId('uncoached-p'), 'Uncoached', 25 * 52, startingAttributes(), uncoachedManager);
    uncoachedPlayer.setTrainingFocus({ kind: 'surface', surface: 'grass' });
    uncoachedPlayer.pullDomainEvents();
    await players.save(uncoachedPlayer);

    const coaches = new InMemoryCoachRepository();
    await coaches.save(Coach.convert(CoachId('c1'), coachedManager, 100, PlayerId('retired-source'), 'Ex Player'));

    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new FixedTrainingPolicy(10),
      coaches,
      new InMemoryRankingLedgerRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const coachedResult = (await players.findById(PlayerId('coached-p')))!.attributes.surfaceAffinities.get('grass');
    const uncoachedResult = (await players.findById(PlayerId('uncoached-p')))!.attributes.surfaceAffinities.get('grass');
    expect(coachedResult).toBeGreaterThan(uncoachedResult); // same base delta, coach pushes one higher
    expect(uncoachedResult).toBe(30); // 20 + 10, exactly the uncoached base delta
  });

  describe('junior graduation carryover', () => {
    function entry(playerId: PlayerId, points: number, ageBand: 'u14' | 'u16' | null): RankingLedgerEntry {
      return {
        playerId,
        tournamentId: TournamentId('t'),
        tier: ageBand ? 'j100' : 'challenger',
        ageBand,
        points,
        weekEarned: { season: 1, week: 1 },
      };
    }

    it('records a dormant bonus sized as GRADUATION_CARRYOVER_FRACTION of the old band total the exact week a player crosses U14 -> U16', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const worldId = WorldId('main');
      await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));

      // 14*52 (not 14*52 - 1) is the real, inclusive U14 upper edge —
      // "14-and-under" — so this player is still U14-eligible one tick
      // before this test starts them; the tick below crosses them to
      // 14*52 + 1, the first genuinely-U16 week.
      const player = Player.hire(PlayerId('p1'), 'Player 1', 14 * 52, startingAttributes(), ManagerId('m1'));
      player.pullDomainEvents();
      await players.save(player);
      await rankingLedger.append(entry(PlayerId('p1'), 100, 'u14'));

      const standardAging = new PlayerAgingService(new StandardAgingPolicy());
      const useCase = new AdvanceWorldWeekUseCase(
        worlds,
        players,
        new FakeBillingPort(),
        standardAging,
        standardAging,
        new RecordingEventPublisher(),
        new StandardTrainingPolicy(),
        new InMemoryCoachRepository(),
        rankingLedger,
      );

      await useCase.execute({ worldId, tickKey: 'tick-1' });

      const aged = await players.findById(PlayerId('p1'));
      expect(aged!.ageInWeeks).toBe(14 * 52 + 1); // exactly crossed into U16 eligibility
      expect(aged!.dormantCarryoverBonus).toEqual({
        targetBand: 'u16',
        bonusPoints: 100 * GRADUATION_CARRYOVER_FRACTION,
      });

      // The dormant bonus is recorded WITHOUT ever writing a
      // ranking-ledger entry — aging alone never manufactures a
      // ranking.
      expect(await rankingLedger.findAll()).toHaveLength(1); // still just the original U14 entry
    });

    it('records nothing when the player has no ranking at all in the band they are leaving', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository(); // empty
      const worldId = WorldId('main');
      await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));

      const player = Player.hire(PlayerId('p1'), 'Player 1', 14 * 52 - 1, startingAttributes(), ManagerId('m1'));
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
        new StandardTrainingPolicy(),
        new InMemoryCoachRepository(),
        rankingLedger,
      );

      await useCase.execute({ worldId, tickKey: 'tick-1' });

      const aged = await players.findById(PlayerId('p1'));
      expect(aged!.ageInWeeks).toBe(14 * 52);
      expect(aged!.dormantCarryoverBonus).toBeNull();
    });

    it('does not touch dormantCarryoverBonus for a player who does not cross a band boundary this tick', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const worldId = WorldId('main');
      await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));

      // Comfortably mid-U14, nowhere near the 14-year boundary.
      const player = Player.hire(PlayerId('p1'), 'Player 1', 10 * 52, startingAttributes(), ManagerId('m1'));
      player.pullDomainEvents();
      await players.save(player);
      await rankingLedger.append(entry(PlayerId('p1'), 100, 'u14'));

      const standardAging = new PlayerAgingService(new StandardAgingPolicy());
      const useCase = new AdvanceWorldWeekUseCase(
        worlds,
        players,
        new FakeBillingPort(),
        standardAging,
        standardAging,
        new RecordingEventPublisher(),
        new StandardTrainingPolicy(),
        new InMemoryCoachRepository(),
        rankingLedger,
      );

      await useCase.execute({ worldId, tickKey: 'tick-1' });

      expect((await players.findById(PlayerId('p1')))!.dormantCarryoverBonus).toBeNull();
    });

    it('a player who crosses a band boundary but never plays/wins in the new band has NO ranking there at all — the dormant bonus never manufactures one', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const worldId = WorldId('main');
      await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));

      // See the first test in this describe block for why 14*52 (not
      // 14*52 - 1) is the correct starting age to cross on this tick.
      const player = Player.hire(PlayerId('p1'), 'Player 1', 14 * 52, startingAttributes(), ManagerId('m1'));
      player.pullDomainEvents();
      await players.save(player);
      await rankingLedger.append(entry(PlayerId('p1'), 100, 'u14'));

      const standardAging = new PlayerAgingService(new StandardAgingPolicy());
      const useCase = new AdvanceWorldWeekUseCase(
        worlds,
        players,
        new FakeBillingPort(),
        standardAging,
        standardAging,
        new RecordingEventPublisher(),
        new StandardTrainingPolicy(),
        new InMemoryCoachRepository(),
        rankingLedger,
      );

      await useCase.execute({ worldId, tickKey: 'tick-1' }); // crosses U14 -> U16, records a dormant bonus

      const aged = await players.findById(PlayerId('p1'));
      expect(aged!.dormantCarryoverBonus).not.toBeNull(); // bonus WAS recorded...

      // ...but the player never plays a U16 match, so a U16
      // rank-position query must show them as genuinely unranked
      // (NR), not ranked at some phantom score.
      const u16Rankings = new RankPositionQuery(rankingLedger, worlds, worldId, 'u16');
      expect(await u16Rankings.rankFor(PlayerId('p1'))).toEqual({ totalPoints: 0, rank: null });
      expect(await u16Rankings.sortedRankings()).toEqual([]);
    });
  });
});
