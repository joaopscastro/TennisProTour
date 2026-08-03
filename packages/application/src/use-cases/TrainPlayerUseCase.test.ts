import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { TrainingFocus, TrainingPolicy } from '@tennis-manager/domain';
import { PlayerRepository } from '../ports/ports';
import { TrainPlayerUseCase } from './TrainPlayerUseCase';

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

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }
}

/** Deterministic stand-in for StandardTrainingPolicy so the use case
 * test only has to verify orchestration (load, delegate, persist),
 * not real balance numbers. */
class FixedTrainingPolicy implements TrainingPolicy {
  constructor(private readonly delta: number) {}

  computeDelta(): number {
    return this.delta;
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

describe('TrainPlayerUseCase', () => {
  it('trains a surface focus and persists the updated player', async () => {
    const players = new InMemoryPlayerRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    await players.save(player);

    const useCase = new TrainPlayerUseCase(players, new FixedTrainingPolicy(5));
    const focus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    await useCase.execute({ playerId: PlayerId('p1'), focus });

    const saved = await players.findById(PlayerId('p1'));
    expect(saved!.attributes.surfaceAffinities.get('clay')).toBe(25);
    expect(saved!.attributes.surfaceAffinities.get('grass')).toBe(20);
  });

  it('trains a skill-cluster focus and persists the updated player', async () => {
    const players = new InMemoryPlayerRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    await players.save(player);

    const useCase = new TrainPlayerUseCase(players, new FixedTrainingPolicy(4));
    const focus: TrainingFocus = { kind: 'skill', cluster: 'mental' };

    await useCase.execute({ playerId: PlayerId('p1'), focus });

    const saved = await players.findById(PlayerId('p1'));
    expect(saved!.attributes.mental.clutch.value).toBe(34);
    expect(saved!.attributes.physical.speed.value).toBe(30);
  });

  it('throws when the player does not exist', async () => {
    const players = new InMemoryPlayerRepository();
    const useCase = new TrainPlayerUseCase(players, new FixedTrainingPolicy(5));

    await expect(
      useCase.execute({ playerId: PlayerId('ghost'), focus: { kind: 'surface', surface: 'clay' } }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when the player is retired, and does not persist any change', async () => {
    const players = new InMemoryPlayerRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 38 * 52, startingAttributes(), ManagerId('m1'));
    player.advanceWeek(38 * 52 + 1, 'retired', startingAttributes());
    await players.save(player);

    const useCase = new TrainPlayerUseCase(players, new FixedTrainingPolicy(5));

    await expect(
      useCase.execute({ playerId: PlayerId('p1'), focus: { kind: 'surface', surface: 'clay' } }),
    ).rejects.toThrow(/Cannot train retired player/);
  });
});
