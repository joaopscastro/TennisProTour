import { describe, expect, it } from 'vitest';
import {
  AcceleratedDeclinePolicy,
  AgingPolicy,
  Coach,
  CoachId,
  GameWeek,
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
  Tournament,
  TournamentId,
  TrainingPolicy,
  TrainingScheduleEntry,
  WEEKS_PER_SEASON,
  WorldId,
} from '@tennis-manager/domain';
import {
  BillingPort,
  CoachRepository,
  EventPublisherPort,
  GameWorldRepository,
  ManagerLadderRepository,
  ManagerLadderStanding,
  PlayerRepository,
  RankingLedgerRepository,
  TournamentRepository,
  TrainingScheduleRepository,
} from '../ports/ports';
import { RankPositionQuery } from '../queries/RankPositionQuery';
import { AdvanceWorldWeekUseCase, AdvanceWorldWeekResult, FATIGUE_RECOVERY_PER_DAY, FORM_WEEKLY_DECAY } from './AdvanceWorldWeekUseCase';
import { StandardManagerLadderPolicy } from '@tennis-manager/domain';
import { StandardPlayerDevelopmentPolicy } from '@tennis-manager/domain';

class InMemoryManagerLadderRepository implements ManagerLadderRepository {
  readonly scores = new Map<ManagerId, number>();
  async scoreFor(managerId: ManagerId): Promise<number> {
    return this.scores.get(managerId) ?? 0;
  }
  async credit(managerId: ManagerId, amount: number): Promise<void> {
    if (amount <= 0) return;
    this.scores.set(managerId, (this.scores.get(managerId) ?? 0) + amount);
  }
  async decayAll(factor: number): Promise<void> {
    for (const [id, score] of this.scores) this.scores.set(id, score * factor);
  }
  readonly decayManagersCalls: Array<{ managerIds: ManagerId[]; factor: number }> = [];
  async decayManagers(managerIds: ManagerId[], factor: number): Promise<void> {
    this.decayManagersCalls.push({ managerIds, factor });
    for (const id of managerIds) {
      const score = this.scores.get(id);
      if (score !== undefined) this.scores.set(id, score * factor);
    }
  }
  async topStandings(limit: number): Promise<ManagerLadderStanding[]> {
    return [...this.scores.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([managerId, score]) => ({ managerId, score }));
  }
  async rankFor(managerId: ManagerId): Promise<number | null> {
    const score = this.scores.get(managerId) ?? 0;
    if (score <= 0) return null;
    let higher = 0;
    for (const [, s] of this.scores) if (s > score) higher++;
    return higher + 1;
  }
}

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

class InMemoryTrainingScheduleRepository implements TrainingScheduleRepository {
  readonly entries: TrainingScheduleEntry[] = [];

  async findByPlayer(playerId: PlayerId): Promise<TrainingScheduleEntry[]> {
    return this.entries.filter((e) => e.playerId === playerId);
  }

  async save(entry: TrainingScheduleEntry): Promise<void> {
    const i = this.entries.findIndex(
      (e) => e.playerId === entry.playerId && e.effectiveFrom.season === entry.effectiveFrom.season && e.effectiveFrom.week === entry.effectiveFrom.week,
    );
    if (i >= 0) this.entries[i] = entry;
    else this.entries.push(entry);
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

  async findFreeAgents(): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === null && !p.isRetired());
  }

  async save(player: Player): Promise<void> {
    this.saveCount += 1;
    this.store.set(player.id, player);
  }
}

/** Always empty — no test in this file registers a real tournament
 * entry, so `findByPlayerAndWeek`/`findDoublesByPlayerAndWeek` never
 * report activity, which is fine for every pre-existing test (none of
 * them assert on the inactivity penalty). The inactivity-penalty tests
 * below construct their own tournaments directly via `save`. */
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

  async findDoublesByPlayerAndWeek(playerId: PlayerId, week: GameWeek): Promise<Tournament[]> {
    return [...this.store.values()].filter(
      (t) =>
        t.weekScheduled.season === week.season &&
        t.weekScheduled.week === week.week &&
        t.doublesEntrants.some((id) => id === playerId),
    );
  }

  async save(tournament: Tournament): Promise<void> {
    this.store.set(tournament.id, tournament);
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
  const schedule = new InMemoryTrainingScheduleRepository();
  const worldId = WorldId('main');
  await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
  for (let i = 1; i <= playerCount; i++) {
    const player = Player.hire(PlayerId(`p${i}`), `Player ${i}`, 25 * 52, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    await players.save(player);
  }
  players.saveCount = 0;
  const standardAging = new PlayerAgingService(new StandardAgingPolicy());
  const coaches = new InMemoryCoachRepository();
  const ladder = new InMemoryManagerLadderRepository();
  const ladderPolicy = new StandardManagerLadderPolicy();
  const tournaments = new InMemoryTournamentRepository();
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
    schedule,
    ladder,
    ladderPolicy,
    new StandardPlayerDevelopmentPolicy(),
    tournaments,
  );
  return { worlds, players, events, worldId, useCase, coaches, schedule, ladder, ladderPolicy, tournaments };
}

// A game week is now 7 day-ticks (see docs/day-tick-and-scheduling.md).
// The world clock advances one DAY per execute(); the weekly systems
// (aging/training/graduation) fire only on the day-7 -> day-1 rollover.
// Tests position their world at day 7 so the FIRST execute rolls the
// week over; this helper advances a FULL further week for the few
// multi-week tests, ticking (with unique keys) until the next rollover
// and returning that rollover tick's result.
let weeklyTickSeq = 0;
async function advanceOneWeek(
  useCase: AdvanceWorldWeekUseCase,
  worldId: WorldId,
): Promise<AdvanceWorldWeekResult> {
  for (;;) {
    const r = await useCase.execute({ worldId, tickKey: `auto-week-${++weeklyTickSeq}` });
    if (r.weekRolledOver) return r;
  }
}

describe('AdvanceWorldWeekUseCase', () => {
  it('advances the world one week and ages every player', async () => {
    const { worlds, players, worldId, useCase } = await setup(3);

    const result = await useCase.execute({ worldId, tickKey: '2026-W31' });

    expect(result).toEqual({ advanced: true, weekRolledOver: true, playersAged: 3, seasonRolledOver: false });
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 2 });
    for (const player of await players.findAll()) {
      expect(player.ageInWeeks).toBe(25 * 52 + 1);
    }
  });

  it('decays every manager ladder score once per weekly rollover', async () => {
    const { worldId, useCase, ladder, ladderPolicy } = await setup(1);
    await ladder.credit(ManagerId('m1'), 1000);
    await ladder.credit(ManagerId('m2'), 500);

    const result = await useCase.execute({ worldId, tickKey: 'decay-week-1' });
    expect(result.weekRolledOver).toBe(true);

    const factor = ladderPolicy.weeklyDecayFactor();
    // setup(1) rosters a single player under m1, and this test never
    // registers any tournament entry — so m1 is genuinely inactive and
    // also takes the extra inactivity penalty on top of the routine
    // decay (see the dedicated inactivity-penalty tests below for that
    // mechanic in isolation). m2 owns no players at all, so it's never
    // considered for the inactivity check and only ever takes the
    // routine decay.
    const inactivityFactor = ladderPolicy.inactivityPenaltyFactor();
    expect(await ladder.scoreFor(ManagerId('m1'))).toBeCloseTo(1000 * factor * inactivityFactor);
    expect(await ladder.scoreFor(ManagerId('m2'))).toBeCloseTo(500 * factor);
  });

  it('applies the extra inactivity penalty to a manager who registered nobody all week', async () => {
    const { worldId, useCase, ladder, ladderPolicy, tournaments } = await setup(1);
    await ladder.credit(ManagerId('m1'), 1000);

    await useCase.execute({ worldId, tickKey: 'inactive-week-1' });

    const factor = ladderPolicy.weeklyDecayFactor();
    const inactivityFactor = ladderPolicy.inactivityPenaltyFactor();
    expect(await ladder.scoreFor(ManagerId('m1'))).toBeCloseTo(1000 * factor * inactivityFactor);
    expect(ladder.decayManagersCalls).toEqual([{ managerIds: [ManagerId('m1')], factor: inactivityFactor }]);
  });

  it('spares a manager who registered at least one player in a tournament this week', async () => {
    const { worldId, useCase, ladder, ladderPolicy, tournaments } = await setup(1);
    await ladder.credit(ManagerId('m1'), 1000);
    const tournament = Tournament.open({
      name: 'Test Tournament',
      id: TournamentId('t1'),
      tier: 'futures',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
    });
    tournament.registerEntrant({ playerId: PlayerId('p1'), seed: 1 });
    await tournaments.save(tournament);

    await useCase.execute({ worldId, tickKey: 'active-week-1' });

    const factor = ladderPolicy.weeklyDecayFactor();
    expect(await ladder.scoreFor(ManagerId('m1'))).toBeCloseTo(1000 * factor);
    expect(ladder.decayManagersCalls).toEqual([{ managerIds: [], factor: ladderPolicy.inactivityPenaltyFactor() }]);
  });

  it('spares a manager whose only activity this week was a doubles entry', async () => {
    const { worldId, useCase, ladder, tournaments } = await setup(1);
    await ladder.credit(ManagerId('m1'), 1000);
    const tournament = Tournament.open({
      name: 'Test Doubles Tournament',
      id: TournamentId('t1'),
      tier: 'futures',
      surface: 'hard',
      weekScheduled: { season: 1, week: 1 },
      drawSize: 16,
      doublesDrawSize: 4,
    });
    tournament.registerDoublesEntrant(PlayerId('p1'));
    await tournaments.save(tournament);

    await useCase.execute({ worldId, tickKey: 'doubles-active-week-1' });

    expect(ladder.decayManagersCalls).toEqual([{ managerIds: [], factor: expect.any(Number) }]);
  });

  it('never penalizes a manager with no rostered players at all', async () => {
    const { worldId, useCase, ladder } = await setup(0);
    await ladder.credit(ManagerId('m1'), 1000);

    await useCase.execute({ worldId, tickKey: 'no-players-week-1' });

    expect(ladder.decayManagersCalls).toEqual([{ managerIds: [], factor: expect.any(Number) }]);
  });

  it('does not decay the ladder on a mid-week day tick (no rollover)', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    // Position at day 3 so the next execute is a mid-week tick, not a rollover.
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 3, lastAppliedTick: null }));
    const standardAging = new PlayerAgingService(new StandardAgingPolicy());
    const ladder = new InMemoryManagerLadderRepository();
    const useCase = new AdvanceWorldWeekUseCase(
      worlds,
      players,
      new FakeBillingPort(),
      standardAging,
      standardAging,
      new RecordingEventPublisher(),
      new StandardTrainingPolicy(),
      new InMemoryCoachRepository(),
      new InMemoryRankingLedgerRepository(),
      new InMemoryTrainingScheduleRepository(),
      ladder,
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );
    await ladder.credit(ManagerId('m1'), 1000);

    const result = await useCase.execute({ worldId, tickKey: 'midweek-1' });
    expect(result.weekRolledOver).toBe(false);
    expect(await ladder.scoreFor(ManagerId('m1'))).toBe(1000);
  });

  describe('fatigue recovery and form decay', () => {
    it('recovers fatigue on a MID-WEEK day tick without decaying form or aging', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const worldId = WorldId('main');
      // Day 3 of 7 — the next tick is a mid-week day, NOT a rollover.
      await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 3, lastAppliedTick: null }));
      const player = Player.hire(PlayerId('p1'), 'Tired Player', 25 * 52, startingAttributes(), ManagerId('m1'));
      player.applyMatchFatigue(50);
      player.applyMatchForm(20);
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
        new InMemoryRankingLedgerRepository(),
        new InMemoryTrainingScheduleRepository(),
        new InMemoryManagerLadderRepository(),
        new StandardManagerLadderPolicy(),
        new StandardPlayerDevelopmentPolicy(),
        new InMemoryTournamentRepository(),
      );

      const result = await useCase.execute({ worldId, tickKey: 'mid-week-tick' });

      expect(result).toEqual({ advanced: true, weekRolledOver: false, playersAged: 0, seasonRolledOver: false });
      const after = (await players.findById(PlayerId('p1')))!;
      expect(after.fatigue).toBe(50 - FATIGUE_RECOVERY_PER_DAY);
      expect(after.form).toBe(20); // form only decays on the weekly rollover
      expect(after.ageInWeeks).toBe(25 * 52); // no aging mid-week
    });

    it('recovers a day of fatigue AND decays form on the weekly rollover', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const worldId = WorldId('main');
      await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
      const player = Player.hire(PlayerId('p1'), 'Tired Player', 25 * 52, startingAttributes(), ManagerId('m1'));
      player.applyMatchFatigue(50);
      player.applyMatchForm(20);
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
        new InMemoryRankingLedgerRepository(),
        new InMemoryTrainingScheduleRepository(),
        new InMemoryManagerLadderRepository(),
        new StandardManagerLadderPolicy(),
        new StandardPlayerDevelopmentPolicy(),
        new InMemoryTournamentRepository(),
      );

      const result = await useCase.execute({ worldId, tickKey: 'rollover-tick' });

      expect(result.weekRolledOver).toBe(true);
      const after = (await players.findById(PlayerId('p1')))!;
      expect(after.fatigue).toBe(50 - FATIGUE_RECOVERY_PER_DAY);
      expect(after.form).toBe(Math.round(20 * FORM_WEEKLY_DECAY));
    });
  });

  it('is a no-op when run twice for the same tick', async () => {
    const { worlds, players, worldId, useCase } = await setup(3);

    const first = await useCase.execute({ worldId, tickKey: '2026-W31' });
    const savesAfterFirst = players.saveCount;
    const second = await useCase.execute({ worldId, tickKey: '2026-W31' });

    expect(first.advanced).toBe(true);
    expect(second).toEqual({ advanced: false, weekRolledOver: false, playersAged: 0, seasonRolledOver: false });
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
    const result = await advanceOneWeek(useCase, worldId);

    expect(result.advanced).toBe(true);
    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 1, week: 3 });
  });

  it('rolls the season over after week 52', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 52 }, currentDay: 7, lastAppliedTick: null }));
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
      new InMemoryTrainingScheduleRepository(),
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick' });

    expect((await worlds.findById(worldId))!.currentWeek).toEqual({ season: 2, week: 1 });
  });

  it('publishes PlayerRetired when the weekly advance tips a player into retirement', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
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
      new InMemoryTrainingScheduleRepository(),
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick' });

    expect((await players.findById(PlayerId('old')))!.stage).toBe('retired');
    expect(events.published.some((e) => e.type === 'PlayerRetired')).toBe(true);
  });

  it('applies the Pro tradeoff: Pro-managed players decline faster than free-managed ones', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));

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
      new InMemoryTrainingScheduleRepository(),
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick' });

    // Both started at serve 30. Free: -2 -> 28. Pro: -2 * 2 -> 26.
    expect((await players.findById(PlayerId('free-p')))!.attributes.technical.serve.value).toBe(28);
    expect((await players.findById(PlayerId('pro-p')))!.attributes.technical.serve.value).toBe(26);
  });

  it('applies no training delta for a player with no schedule entry at all', async () => {
    const { players, worldId, useCase } = await setup(1);

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const player = await players.findById(PlayerId('p1'));
    expect(player!.attributes.surfaceAffinities.get('clay')).toBe(20); // untouched
  });

  it('applies the resolved standing training focus automatically on tick, with no separate use-case call', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const schedule = new InMemoryTrainingScheduleRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
    const player = Player.hire(PlayerId('p1'), 'Player 1', 25 * 52, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    player.gainExperience(10000); // P4: training is now XP-funded; give ample balance so the standing-order mechanic under test applies fully
    await players.save(player);
    await schedule.save({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'grass' } });

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
      schedule,
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const trained = await players.findById(PlayerId('p1'));
    expect(trained!.attributes.surfaceAffinities.get('grass')).toBe(26); // 20 + 6
    expect(trained!.attributes.surfaceAffinities.get('clay')).toBe(20); // untouched
  });

  it('scheduling a future-week focus change does not retroactively affect a tick that already ran, and applies exactly at the scheduled week', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const schedule = new InMemoryTrainingScheduleRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
    const player = Player.hire(PlayerId('p1'), 'Player 1', 25 * 52, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    player.gainExperience(10000); // P4: XP-funded training
    await players.save(player);

    // Standing order from week 1: clay. A future order for week 3: serve.
    await schedule.save({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'clay' } });
    await schedule.save({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 3 }, focus: { kind: 'attribute', attribute: 'serve' } });

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
      schedule,
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    // Tick 1: world moves to week 2 — still under the week-1 clay order.
    await useCase.execute({ worldId, tickKey: 'tick-1' });
    let p = await players.findById(PlayerId('p1'));
    expect(p!.attributes.surfaceAffinities.get('clay')).toBe(26); // 20 + 6, week-1 order applied
    expect(p!.attributes.technical.serve.value).toBe(30); // untouched — week 3's order hasn't arrived

    // Tick 2: world moves to week 3 — the scheduled future entry now applies.
    await advanceOneWeek(useCase, worldId);
    p = await players.findById(PlayerId('p1'));
    expect(p!.attributes.technical.serve.value).toBe(36); // 30 + 6, week-3 order now in effect
    expect(p!.attributes.surfaceAffinities.get('clay')).toBe(26); // untouched this tick — no longer the standing order

    // The already-applied week-1 tick's effect is exactly what it was
    // when it ran — nothing about it changed retroactively just
    // because a later entry now exists.
    expect(p!.attributes.surfaceAffinities.get('clay')).toBe(26);
  });

  it('a fillOnly player ignores the schedule entirely (auto-trains its weakest attribute), even if a schedule entry somehow exists for it', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const schedule = new InMemoryTrainingScheduleRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
    const attributes = startingAttributes().trainedOnAttribute('backhand', -10); // 30 -> 20
    const fillOnly = Player.generateFillOnly(PlayerId('filler-1'), 'Filler One', 25 * 52, 'prime', attributes);
    fillOnly.pullDomainEvents();
    fillOnly.gainExperience(10000); // P4: XP-funded training
    await players.save(fillOnly);
    // Even a stray schedule entry (should never really happen — no
    // manager exists to create one) must not override the fillOnly
    // auto-training branch.
    await schedule.save({ playerId: PlayerId('filler-1'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'grass' } });

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
      schedule,
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const trained = await players.findById(PlayerId('filler-1'));
    expect(trained!.ageInWeeks).toBe(25 * 52 + 1);
    expect(trained!.attributes.attributeValue('backhand')).toBe(26); // weakest attribute trained
    expect(trained!.attributes.surfaceAffinities.get('grass')).toBe(20); // the stray schedule entry was ignored
    expect(trained!.managerId).toBeNull();
  });

  it('re-targets the fill-only auto-training focus as the weakest attribute changes week over week, instead of freezing on the first pick', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
    // backhand (20) starts weakest; a single +6 session brings it to 26,
    // which ties speed/stamina/strength at their own starting 30 only
    // if nothing else changes — set stamina lower (18) so it becomes
    // the new weakest attribute on the SECOND tick, proving the focus
    // isn't just fixed once at generation time.
    let attributes = startingAttributes().trainedOnAttribute('backhand', -10); // 30 -> 20
    attributes = attributes.trainedOnAttribute('stamina', -12); // 30 -> 18
    const fillOnly = Player.generateFillOnly(PlayerId('filler-1'), 'Filler One', 25 * 52, 'prime', attributes);
    fillOnly.pullDomainEvents();
    fillOnly.gainExperience(10000); // P4: XP-funded training
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
      new InMemoryTrainingScheduleRepository(),
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });
    let mid = await players.findById(PlayerId('filler-1'));
    expect(mid!.attributes.attributeValue('stamina')).toBe(24); // 18 + 6: this tick's weakest
    expect(mid!.attributes.attributeValue('backhand')).toBe(20); // untouched this tick

    await advanceOneWeek(useCase, worldId);
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
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
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
      new InMemoryTrainingScheduleRepository(),
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const retired = await players.findById(PlayerId('filler-1'));
    expect(retired!.isRetired()).toBe(true);
    expect(retired!.attributes.attributeValue('serve')).toBe(30); // no training delta applied
  });

  it('does not double-apply training when the same tick is re-run (idempotent, like aging)', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const schedule = new InMemoryTrainingScheduleRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));
    const player = Player.hire(PlayerId('p1'), 'Player 1', 25 * 52, startingAttributes(), ManagerId('m1'));
    player.pullDomainEvents();
    player.gainExperience(10000); // P4: XP-funded training
    await players.save(player);
    await schedule.save({ playerId: PlayerId('p1'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'attribute', attribute: 'serve' } });

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
      schedule,
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });
    const second = await useCase.execute({ worldId, tickKey: 'tick-1' });

    expect(second).toEqual({ advanced: false, weekRolledOver: false, playersAged: 0, seasonRolledOver: false });
    expect((await players.findById(PlayerId('p1')))!.attributes.technical.serve.value).toBe(33); // 30 + 3, not +6
  });

  it("boosts a player's weekly training by their manager's coach, and leaves a coachless manager's players unboosted", async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const schedule = new InMemoryTrainingScheduleRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));

    const coachedManager = ManagerId('coached-m');
    const uncoachedManager = ManagerId('uncoached-m');
    const coachedPlayer = Player.hire(PlayerId('coached-p'), 'Coached', 25 * 52, startingAttributes(), coachedManager);
    coachedPlayer.pullDomainEvents();
    coachedPlayer.gainExperience(10000); // P4: XP-funded training
    await players.save(coachedPlayer);
    await schedule.save({ playerId: PlayerId('coached-p'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'grass' } });
    const uncoachedPlayer = Player.hire(PlayerId('uncoached-p'), 'Uncoached', 25 * 52, startingAttributes(), uncoachedManager);
    uncoachedPlayer.pullDomainEvents();
    uncoachedPlayer.gainExperience(10000); // P4: XP-funded training
    await players.save(uncoachedPlayer);
    await schedule.save({ playerId: PlayerId('uncoached-p'), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'surface', surface: 'grass' } });

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
      schedule,
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    await useCase.execute({ worldId, tickKey: 'tick-1' });

    const coachedResult = (await players.findById(PlayerId('coached-p')))!.attributes.surfaceAffinities.get('grass');
    const uncoachedResult = (await players.findById(PlayerId('uncoached-p')))!.attributes.surfaceAffinities.get('grass');
    expect(coachedResult).toBeGreaterThan(uncoachedResult); // same base delta, coach pushes one higher
    expect(uncoachedResult).toBe(30); // 20 + 10, exactly the uncoached base delta
  });

  it('funds weekly training from talent income only: a higher-talent player grows more per tick, a zero-talent player not at all (P4)', async () => {
    const worlds = new InMemoryGameWorldRepository();
    const players = new InMemoryPlayerRepository();
    const schedule = new InMemoryTrainingScheduleRepository();
    const worldId = WorldId('main');
    await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));

    // Three players, identical starting attributes + identical standing
    // training order, differing ONLY in talent. Crucially NO player is
    // pre-funded with experience — the only thing that can pay for this
    // tick's training is the weekly talent income credited on the tick
    // itself, so growth is strictly a function of talent.
    const mk = (id: string, talent: number) =>
      Player.hire(PlayerId(id), id, 25 * 52, startingAttributes(), ManagerId('m1'), 'XX', 100, { speed: 100, stamina: 100, strength: 100 }, talent);
    for (const [id, talent] of [['high-t', 95], ['low-t', 50], ['zero-t', 0]] as const) {
      const p = mk(id, talent);
      p.pullDomainEvents();
      await players.save(p);
      await schedule.save({ playerId: PlayerId(id), effectiveFrom: { season: 1, week: 1 }, focus: { kind: 'attribute', attribute: 'serve' } });
    }

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
      schedule,
      new InMemoryManagerLadderRepository(),
      new StandardManagerLadderPolicy(),
      new StandardPlayerDevelopmentPolicy(),
      new InMemoryTournamentRepository(),
    );

    // Run several ticks so the slow weekly income accumulates into
    // visible skill points. NOTE the disclosed integer-rounding plateau
    // (see Player.applyTraining): a per-tick funded delta below ~0.5
    // rounds away entirely, so talents are chosen here to clear that
    // per-tick threshold; a talent-0 player earns nothing and never
    // grows regardless of weeks.
    await useCase.execute({ worldId, tickKey: 'tick-1' });
    for (let i = 2; i <= 20; i++) await advanceOneWeek(useCase, worldId);

    const serveOf = async (id: string) => (await players.findById(PlayerId(id)))!.attributes.technical.serve.value;
    const high = await serveOf('high-t');
    const low = await serveOf('low-t');
    const zero = await serveOf('zero-t');

    expect(zero).toBe(30); // no talent income, no match XP => no funding => no growth at all
    expect(high).toBeGreaterThan(low); // more talent funds more training over the same weeks
    expect(low).toBeGreaterThan(zero); // some talent still develops, just slower
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

    it('records a dormant bonus sized as GRADUATION_CARRYOVER_FRACTION of the old band total the exact SEASON a player crosses U14 -> U16', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const worldId = WorldId('main');
      // Junior eligibility is anchored to seasonAgeAnchorWeeks (the real
      // ITF "age as of January 1" rule — see Player.seasonAgeAnchorWeeks'
      // doc comment), which only ever refreshes on a SEASON rollover, not
      // an ordinary weekly one — so the world must be sitting at the
      // last week of a season for this tick to actually be that boundary.
      await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: WEEKS_PER_SEASON }, currentDay: 7, lastAppliedTick: null }));

      // 14*52 (not 14*52 - 1) is the real, inclusive U14 upper edge —
      // "14-and-under" — so this player is still U14-eligible one tick
      // before this test starts them; the tick below crosses them to
      // 14*52 + 1, the first genuinely-U16 week, and the same tick's
      // season rollover immediately anchors that as their new eligibility
      // age.
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
        new InMemoryTrainingScheduleRepository(),
        new InMemoryManagerLadderRepository(),
        new StandardManagerLadderPolicy(),
        new StandardPlayerDevelopmentPolicy(),
        new InMemoryTournamentRepository(),
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
      await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));

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
        new InMemoryTrainingScheduleRepository(),
        new InMemoryManagerLadderRepository(),
        new StandardManagerLadderPolicy(),
        new StandardPlayerDevelopmentPolicy(),
        new InMemoryTournamentRepository(),
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
      await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 1 }, currentDay: 7, lastAppliedTick: null }));

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
        new InMemoryTrainingScheduleRepository(),
        new InMemoryManagerLadderRepository(),
        new StandardManagerLadderPolicy(),
        new StandardPlayerDevelopmentPolicy(),
        new InMemoryTournamentRepository(),
      );

      await useCase.execute({ worldId, tickKey: 'tick-1' });

      expect((await players.findById(PlayerId('p1')))!.dormantCarryoverBonus).toBeNull();
    });

    it('a player who crosses a band boundary but never plays/wins in the new band has NO ranking there at all — the dormant bonus never manufactures one', async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const worldId = WorldId('main');
      // See the first test in this describe block for why the world
      // must be at the last week of a season for a crossing to happen
      // at all now that eligibility is anchored, not raw-age-based.
      await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: WEEKS_PER_SEASON }, currentDay: 7, lastAppliedTick: null }));

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
        new InMemoryTrainingScheduleRepository(),
        new InMemoryManagerLadderRepository(),
        new StandardManagerLadderPolicy(),
        new StandardPlayerDevelopmentPolicy(),
        new InMemoryTournamentRepository(),
      );

      await useCase.execute({ worldId, tickKey: 'tick-1' }); // season rollover: crosses U14 -> U16, records a dormant bonus

      const aged = await players.findById(PlayerId('p1'));
      expect(aged!.dormantCarryoverBonus).not.toBeNull(); // bonus WAS recorded...

      // ...but the player never plays a U16 match, so a U16
      // rank-position query must show them as genuinely unranked
      // (NR), not ranked at some phantom score.
      const u16Rankings = new RankPositionQuery(rankingLedger, worlds, worldId, 'u16');
      expect(await u16Rankings.rankFor(PlayerId('p1'))).toEqual({ totalPoints: 0, rank: null });
      expect(await u16Rankings.sortedRankings()).toEqual([]);
    });

    it("an ordinary MID-SEASON weekly rollover never refreshes the eligibility anchor, even once the player's raw age has crossed a boundary — the real ITF 'age as of January 1' rule the user asked for", async () => {
      const worlds = new InMemoryGameWorldRepository();
      const players = new InMemoryPlayerRepository();
      const rankingLedger = new InMemoryRankingLedgerRepository();
      const worldId = WorldId('main');
      // Week 30, not the last week of the season — this tick's rollover
      // (week 30 -> 31) is an ORDINARY weekly one, not a season boundary.
      await worlds.save(GameWorld.reconstitute({ id: worldId, currentWeek: { season: 1, week: 30 }, currentDay: 7, lastAppliedTick: null }));

      // Hired at exactly 14*52 — hire() sets seasonAgeAnchorWeeks equal
      // to ageInWeeks at creation, so this player's anchor starts at
      // 14*52 too (still genuinely U14-eligible, the inclusive edge).
      const player = Player.hire(PlayerId('p1'), 'Player 1', 14 * 52, startingAttributes(), ManagerId('m1'));
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
        new InMemoryTrainingScheduleRepository(),
        new InMemoryManagerLadderRepository(),
        new StandardManagerLadderPolicy(),
        new StandardPlayerDevelopmentPolicy(),
        new InMemoryTournamentRepository(),
      );

      await useCase.execute({ worldId, tickKey: 'tick-1' }); // ordinary weekly rollover, NOT a season boundary

      const aged = await players.findById(PlayerId('p1'));
      // Raw age crossed the U14/U16 boundary this tick...
      expect(aged!.ageInWeeks).toBe(14 * 52 + 1);
      // ...but the eligibility anchor did NOT move, so the player is
      // still genuinely U14-eligible for the rest of this season —
      // exactly "13y51w on January 1 stays U14-eligible all year",
      // just phrased from the other side of the boundary.
      expect(aged!.seasonAgeAnchorWeeks).toBe(14 * 52);
      expect(aged!.dormantCarryoverBonus).toBeNull(); // no crossing recorded either — none happened yet
    });
  });
});

