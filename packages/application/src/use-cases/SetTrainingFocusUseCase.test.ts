import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { TrainingFocus } from '@tennis-manager/domain';
import { PlayerRepository } from '../ports/ports';
import { SetTrainingFocusUseCase } from './SetTrainingFocusUseCase';

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

function startingAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(30), forehand: Skill.of(30), backhand: Skill.of(30), volley: Skill.of(30) },
    physical: { speed: Skill.of(30), stamina: Skill.of(30), strength: Skill.of(30) },
    mental: { consistency: Skill.of(30), clutch: Skill.of(30) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

describe('SetTrainingFocusUseCase', () => {
  it('records the standing focus and persists it, without applying any attribute delta', async () => {
    const players = new InMemoryPlayerRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    await players.save(player);

    const useCase = new SetTrainingFocusUseCase(players);
    const focus: TrainingFocus = { kind: 'surface', surface: 'clay' };

    await useCase.execute({ playerId: PlayerId('p1'), focus });

    const saved = await players.findById(PlayerId('p1'));
    expect(saved!.currentFocus).toEqual(focus);
    // No delta applied — that's AdvanceWorldWeekUseCase's job on tick.
    expect(saved!.attributes.surfaceAffinities.get('clay')).toBe(20);
  });

  it('clears the standing focus when given null', async () => {
    const players = new InMemoryPlayerRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    player.setTrainingFocus({ kind: 'skill', cluster: 'mental' });
    await players.save(player);

    const useCase = new SetTrainingFocusUseCase(players);
    await useCase.execute({ playerId: PlayerId('p1'), focus: null });

    expect((await players.findById(PlayerId('p1')))!.currentFocus).toBeNull();
  });

  it('throws when the player does not exist', async () => {
    const players = new InMemoryPlayerRepository();
    const useCase = new SetTrainingFocusUseCase(players);

    await expect(
      useCase.execute({ playerId: PlayerId('ghost'), focus: { kind: 'surface', surface: 'clay' } }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when the player is retired, and does not persist any change', async () => {
    const players = new InMemoryPlayerRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 38 * 52, startingAttributes(), ManagerId('m1'));
    player.advanceWeek(38 * 52 + 1, 'retired', startingAttributes());
    await players.save(player);

    const useCase = new SetTrainingFocusUseCase(players);

    await expect(
      useCase.execute({ playerId: PlayerId('p1'), focus: { kind: 'surface', surface: 'clay' } }),
    ).rejects.toThrow(/Cannot set training focus for retired player/);
  });
});
