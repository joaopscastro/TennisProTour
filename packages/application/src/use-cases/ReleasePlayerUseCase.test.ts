import { describe, expect, it } from 'vitest';
import { DoublesPair, ManagerId, PairId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { ReleasePlayerUseCase } from './ReleasePlayerUseCase';
import { InMemoryDoublesPairRepository, InMemoryPlayerRepository, makePlayer } from './doublesTestHelpers';

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
    const pairs = new InMemoryDoublesPairRepository();
    const player = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    await players.save(player);

    const useCase = new ReleasePlayerUseCase(players, pairs);
    await useCase.execute({ playerId: PlayerId('p1') });

    expect((await players.findById(PlayerId('p1')))!.managerId).toBeNull();
  });

  it('throws when the player does not exist', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    const useCase = new ReleasePlayerUseCase(players, pairs);

    await expect(useCase.execute({ playerId: PlayerId('ghost') })).rejects.toThrow(/not found/);
  });

  it('dissolves any pair the released player was part of (the P7a cascade)', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m2')));
    // A cross-manager ACTIVE pair, hand-seeded: the create path no longer
    // forms pending cross-manager invites (both players must share a
    // manager), but legacy active pairs still exist and the release
    // cascade must dissolve them.
    const pair = DoublesPair.propose(PairId('p-ab'), PlayerId('a'), PlayerId('b'));
    pair.accept();
    await pairs.save(pair);
    expect((await pairs.findById(pair.id))!.isActive).toBe(true);

    await new ReleasePlayerUseCase(players, pairs).execute({ playerId: PlayerId('a') });

    expect((await pairs.findById(pair.id))!.isDissolved).toBe(true);
  });
});
