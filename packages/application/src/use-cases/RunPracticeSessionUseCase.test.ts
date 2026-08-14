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

  it('refuses a second practice the same day', async () => {
    const { players, worlds, useCase } = setup();
    await worlds.save(GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: 2, lastAppliedTick: null }));
    await players.save(makePlayer(PlayerId('p1'), ManagerId('m1')));

    await useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') });
    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') })).rejects.toThrow(/already practiced today/);
  });

  it('refuses a player the manager does not own', async () => {
    const { players, worlds, useCase } = setup();
    await worlds.save(GameWorld.reconstitute({ id: WORLD, currentWeek: { season: 1, week: 3 }, currentDay: 2, lastAppliedTick: null }));
    await players.save(makePlayer(PlayerId('p1'), ManagerId('owner')));

    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('m1') })).rejects.toThrow(/not on manager/);
  });
});
