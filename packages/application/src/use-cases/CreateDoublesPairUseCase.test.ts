import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { CreateDoublesPairUseCase } from './CreateDoublesPairUseCase';
import { InMemoryDoublesPairRepository, InMemoryPlayerRepository, makePlayer, SequentialIdGenerator } from './doublesTestHelpers';

function makeUseCase(players: InMemoryPlayerRepository, pairs: InMemoryDoublesPairRepository): CreateDoublesPairUseCase {
  return new CreateDoublesPairUseCase(players, pairs, new SequentialIdGenerator());
}

describe('CreateDoublesPairUseCase', () => {
  it('forms a same-manager pair as active immediately', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    const managerId = ManagerId('m1');
    await players.save(makePlayer(PlayerId('a'), managerId));
    await players.save(makePlayer(PlayerId('b'), managerId));

    const pair = await makeUseCase(players, pairs).execute({ playerA: PlayerId('a'), playerB: PlayerId('b'), managerId });

    expect(pair.isActive).toBe(true);
    expect(pair.playerA).toBe(PlayerId('a'));
    expect(pair.playerB).toBe(PlayerId('b'));
    expect(await pairs.findById(pair.id)).not.toBeNull();
  });

  it('forms a cross-manager pair as a pending invitation', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m2')));

    const pair = await makeUseCase(players, pairs).execute({ playerA: PlayerId('a'), playerB: PlayerId('b'), managerId: ManagerId('m1') });

    expect(pair.isPending).toBe(true);
  });

  it('rejects pairing with a free agent', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('free'), null));

    await expect(
      makeUseCase(players, pairs).execute({ playerA: PlayerId('a'), playerB: PlayerId('free'), managerId: ManagerId('m1') }),
    ).rejects.toThrow(/free agent/);
  });

  it('rejects when the initiating player is not on the manager roster', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('someone-else')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m1')));

    await expect(
      makeUseCase(players, pairs).execute({ playerA: PlayerId('a'), playerB: PlayerId('b'), managerId: ManagerId('m1') }),
    ).rejects.toThrow(/not on manager/);
  });

  it('rejects when either player is already in a non-dissolved pair', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('c'), ManagerId('m1')));

    const useCase = makeUseCase(players, pairs);
    await useCase.execute({ playerA: PlayerId('a'), playerB: PlayerId('b'), managerId: ManagerId('m1') });

    await expect(useCase.execute({ playerA: PlayerId('a'), playerB: PlayerId('c'), managerId: ManagerId('m1') })).rejects.toThrow(
      /already in a doubles pair/,
    );
  });

  it('allows a new pair after the previous one dissolved', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('c'), ManagerId('m1')));

    const useCase = makeUseCase(players, pairs);
    const first = await useCase.execute({ playerA: PlayerId('a'), playerB: PlayerId('b'), managerId: ManagerId('m1') });
    first.dissolve();
    await pairs.save(first);

    const second = await useCase.execute({ playerA: PlayerId('a'), playerB: PlayerId('c'), managerId: ManagerId('m1') });
    expect(second.isActive).toBe(true);
  });
});
