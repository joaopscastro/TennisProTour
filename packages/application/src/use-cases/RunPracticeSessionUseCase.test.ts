import { describe, expect, it } from 'vitest';
import { GameDay, GameWorld, ManagerId, PlayerId, StandardPracticePolicy, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, ManagerLadderRepository, PracticeSessionRepository } from '../ports/ports';
import { RunPracticeSessionUseCase } from './RunPracticeSessionUseCase';
import { InMemoryPlayerRepository, makePlayer } from './doublesTestHelpers';

class InMemoryGameWorldRepository implements GameWorldRepository {
  private world: GameWorld | null = null;
  async findById(): Promise<GameWorld | null> {
    return this.world;
  }
  async save(world: GameWorld): Promise<void> {
    this.world = world;
  }
}

class InMemoryManagerLadderRepository implements ManagerLadderRepository {
  readonly scores = new Map<ManagerId, number>();
  async scoreFor(managerId: ManagerId): Promise<number> {
    return this.scores.get(managerId) ?? 0;
  }
  async credit(managerId: ManagerId, amount: number): Promise<void> {
    this.scores.set(managerId, (this.scores.get(managerId) ?? 0) + amount);
  }
  async decayAll(): Promise<void> {}
  async decayManagers(): Promise<void> {}
  async deductManagers(): Promise<void> {}
  async topStandings(): Promise<never[]> {
    return [];
  }
  async rankFor(): Promise<number | null> {
    return null;
  }
}

class InMemoryPracticeSessionRepository implements PracticeSessionRepository {
  readonly recorded = new Set<string>();
  key(playerId: PlayerId, day: GameDay): string {
    return `${playerId}:${day.season}-${day.week}-${day.day}`;
  }
  async recordedOn(playerId: PlayerId, day: GameDay): Promise<boolean> {
    return this.recorded.has(this.key(playerId, day));
  }
  async record(playerId: PlayerId, day: GameDay): Promise<void> {
    this.recorded.add(this.key(playerId, day));
  }
  async tryRecord(playerId: PlayerId, day: GameDay): Promise<boolean> {
    const key = this.key(playerId, day);
    if (this.recorded.has(key)) return false;
    this.recorded.add(key);
    return true;
  }
  async countInWeek(playerId: PlayerId, week: { season: number; week: number }): Promise<number> {
    const prefix = `${playerId}:${week.season}-${week.week}-`;
    let count = 0;
    for (const key of this.recorded) if (key.startsWith(prefix)) count++;
    return count;
  }
}

const WORLD = WorldId('main');
const TODAY: GameDay = { season: 1, week: 3, day: 2 };

function setup() {
  const players = new InMemoryPlayerRepository();
  const worlds = new InMemoryGameWorldRepository();
  const practices = new InMemoryPracticeSessionRepository();
  const ladder = new InMemoryManagerLadderRepository();
  const useCase = new RunPracticeSessionUseCase(players, worlds, WORLD, practices, ladder, new StandardPracticePolicy());
  return { players, worlds, practices, ladder, useCase };
}

describe('RunPracticeSessionUseCase', () => {
  it('grants experience + ladder, costs a little fatigue, and changes no form', async () => {
    const { players, worlds, practices, ladder, useCase } = setup();
    await worlds.save(GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: 2, lastAppliedTick: null }));
    const player = makePlayer(PlayerId('p1'), ManagerId('m1'));
    player.applyMatchForm(10);
    await players.save(player);

    const result = await useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') });

    expect(result.ladderPoints).toBe(15);
    const after = await players.findById(PlayerId('p1'));
    expect(after!.fatigue).toBe(2);
    expect(after!.form).toBe(10); // practice does NOT touch form
    expect(after!.experience).toBeGreaterThan(0);
    expect(await ladder.scoreFor(ManagerId('m1'))).toBe(15);
    expect(await practices.recordedOn(PlayerId('p1'), TODAY)).toBe(true);
  });

  it('refuses a second practice the same day, awarding nothing on the refused attempt', async () => {
    const { players, worlds, ladder, useCase } = setup();
    await worlds.save(GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: 2, lastAppliedTick: null }));
    await players.save(makePlayer(PlayerId('p1'), ManagerId('m1')));

    await useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') });
    const afterFirst = await players.findById(PlayerId('p1'));
    const ladderAfterFirst = await ladder.scoreFor(ManagerId('m1'));

    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') })).rejects.toThrow(/already practiced today/);

    // The refused attempt awarded nothing extra.
    const afterSecond = await players.findById(PlayerId('p1'));
    expect(afterSecond!.fatigue).toBe(afterFirst!.fatigue);
    expect(afterSecond!.experience).toBe(afterFirst!.experience);
    expect(await ladder.scoreFor(ManagerId('m1'))).toBe(ladderAfterFirst);
  });

  it('two concurrent practices for the same player/day award exactly once (atomic day-claim)', async () => {
    const { players, worlds, ladder, useCase } = setup();
    await worlds.save(GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: 2, lastAppliedTick: null }));
    await players.save(makePlayer(PlayerId('p1'), ManagerId('m1')));

    const results = await Promise.allSettled([
      useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') }),
      useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // Credited exactly once, not twice — the double-click double-spend.
    expect(await ladder.scoreFor(ManagerId('m1'))).toBe(15);
  });

  it('refuses a player the manager does not own', async () => {
    const { players, worlds, useCase } = setup();
    await worlds.save(GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: 2, lastAppliedTick: null }));
    await players.save(makePlayer(PlayerId('p1'), ManagerId('owner')));

    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') })).rejects.toThrow(/not on manager/);
  });

  it('caps the LADDER credit at 3 sessions per player per week — later sessions still grant XP and cost fatigue', async () => {
    const { players, worlds, ladder, useCase } = setup();
    await players.save(makePlayer(PlayerId('p1'), ManagerId('m1')));

    const sessionOn = async (day: number) => {
      await worlds.save(
        GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: day, lastAppliedTick: null }),
      );
      return useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') });
    };

    const results = [];
    for (let day = 1; day <= 5; day++) results.push(await sessionOn(day));

    // The measured before: 5 × 15 = 75 ladder in a week, unbounded up to
    // 105. The bounded after: exactly 3 × 15 = 45.
    expect(results.map((r) => r.ladderPoints)).toEqual([15, 15, 15, 0, 0]);
    expect(await ladder.scoreFor(ManagerId('m1'))).toBe(45);

    // Sessions beyond the cap still do their REAL job — development XP
    // and the fatigue cost — so practice never stops being the training
    // outlet; only the ladder pump is bounded.
    const afterFour = results[3];
    expect(afterFour.experience).toBe(2);
    expect(afterFour.fatigue).toBe(2);
    const player = await players.findById(PlayerId('p1'));
    expect(player!.experience).toBeGreaterThanOrEqual(10); // 5 × 2, never gated
  });

  it('the weekly cap is PER PLAYER — a second rostered player banks their own 3 sessions', async () => {
    const { players, worlds, ladder, useCase } = setup();
    await players.save(makePlayer(PlayerId('p1'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('p2'), ManagerId('m1')));

    for (let day = 1; day <= 4; day++) {
      await worlds.save(
        GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: day, lastAppliedTick: null }),
      );
      await useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') });
      await useCase.execute({ playerId: PlayerId('p2'), managerId: ManagerId('m1') });
    }

    // 3 capped sessions each = 45 each = 90 total; day 4 adds nothing.
    expect(await ladder.scoreFor(ManagerId('m1'))).toBe(90);
  });
});
