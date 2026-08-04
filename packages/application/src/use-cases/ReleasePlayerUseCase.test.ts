import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { PlayerRepository } from '../ports/ports';
import { ReleasePlayerUseCase } from './ReleasePlayerUseCase';

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

describe('ReleasePlayerUseCase', () => {
  it('releases a player from their manager and persists it', async () => {
    const players = new InMemoryPlayerRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    await players.save(player);

    const useCase = new ReleasePlayerUseCase(players);
    await useCase.execute({ playerId: PlayerId('p1') });

    expect((await players.findById(PlayerId('p1')))!.managerId).toBeNull();
  });

  it('throws when the player does not exist', async () => {
    const players = new InMemoryPlayerRepository();
    const useCase = new ReleasePlayerUseCase(players);

    await expect(useCase.execute({ playerId: PlayerId('ghost') })).rejects.toThrow(/not found/);
  });
});
