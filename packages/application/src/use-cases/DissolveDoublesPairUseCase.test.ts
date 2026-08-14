import { describe, expect, it } from 'vitest';
import { DoublesPair, ManagerId, PairId, PlayerId } from '@tennis-manager/domain';
import { CreateDoublesPairUseCase } from './CreateDoublesPairUseCase';
import { DissolveDoublesPairUseCase } from './DissolveDoublesPairUseCase';
import { InMemoryDoublesPairRepository, InMemoryPlayerRepository, makePlayer, SequentialIdGenerator } from './doublesTestHelpers';

describe('DissolveDoublesPairUseCase', () => {
  it('dissolves an active same-manager pair when the caller owns one side', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    const managerId = ManagerId('m1');
    await players.save(makePlayer(PlayerId('a'), managerId));
    await players.save(makePlayer(PlayerId('b'), managerId));
    const pair = await new CreateDoublesPairUseCase(players, pairs, new SequentialIdGenerator()).execute({
      playerA: PlayerId('a'),
      playerB: PlayerId('b'),
      managerId,
    });

    const dissolved = await new DissolveDoublesPairUseCase(pairs, players).execute({ pairId: pair.id, managerId });
    expect(dissolved.isDissolved).toBe(true);
  });

  it('declines a pending cross-manager pair (the invitee dissolving)', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m2')));
    const pair = await new CreateDoublesPairUseCase(players, pairs, new SequentialIdGenerator()).execute({
      playerA: PlayerId('a'),
      playerB: PlayerId('b'),
      managerId: ManagerId('m1'),
    });

    const dissolved = await new DissolveDoublesPairUseCase(pairs, players).execute({ pairId: pair.id, managerId: ManagerId('m2') });
    expect(dissolved.isDissolved).toBe(true);
  });

  it('lets the INITIATING manager dissolve an active cross-manager pair too (either side may)', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m2')));
    const pending = await new CreateDoublesPairUseCase(players, pairs, new SequentialIdGenerator()).execute({
      playerA: PlayerId('a'),
      playerB: PlayerId('b'),
      managerId: ManagerId('m1'),
    });
    pending.accept();
    await pairs.save(pending);

    const dissolved = await new DissolveDoublesPairUseCase(pairs, players).execute({ pairId: pending.id, managerId: ManagerId('m1') });
    expect(dissolved.isDissolved).toBe(true);
  });

  it('rejects dissolving when the caller owns neither player', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    const active = DoublesPair.activate(PairId('p1'), PlayerId('a'), PlayerId('b'));
    await pairs.save(active);

    await expect(
      new DissolveDoublesPairUseCase(pairs, players).execute({ pairId: active.id, managerId: ManagerId('m-other') }),
    ).rejects.toThrow(/does not own either player/);
    expect((await pairs.findById(active.id))!.isActive).toBe(true);
  });

  it('is idempotent on an already-dissolved pair', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    const dissolved = DoublesPair.propose(PairId('p1'), PlayerId('a'), PlayerId('b'));
    dissolved.dissolve();
    await pairs.save(dissolved);

    const again = await new DissolveDoublesPairUseCase(pairs, players).execute({ pairId: dissolved.id, managerId: ManagerId('m-other') });
    expect(again.isDissolved).toBe(true);
  });
});
