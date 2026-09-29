import { describe, expect, it } from 'vitest';
import { DoublesPair, ManagerId, PairId, PlayerId } from '@tennis-manager/domain';
import { AcceptDoublesPairUseCase } from './AcceptDoublesPairUseCase';

// Pending cross-manager pairs are HAND-SEEDED here (DoublesPair.propose):
// CreateDoublesPairUseCase no longer creates them — a pair request now
// requires both players on the caller's roster (the live 201/pending-
// forever bug). Accept itself still works for any genuinely pending row,
// legacy or otherwise, which is what these tests cover.
import { InMemoryDoublesPairRepository, InMemoryPlayerRepository, makePlayer } from './doublesTestHelpers';

describe('AcceptDoublesPairUseCase', () => {
  it('accepts a pending pair when the caller owns the invited player', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m2')));

    const pair = DoublesPair.propose(PairId('p-invite'), PlayerId('a'), PlayerId('b'));
    await pairs.save(pair);
    expect(pair.isPending).toBe(true);

    const accepted = await new AcceptDoublesPairUseCase(pairs, players).execute({ pairId: pair.id, managerId: ManagerId('m2') });
    expect(accepted.isActive).toBe(true);
  });

  it('rejects acceptance by a manager who does not own the invited player', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m2')));

    const pair = DoublesPair.propose(PairId('p-invite'), PlayerId('a'), PlayerId('b'));
    await pairs.save(pair);

    await expect(new AcceptDoublesPairUseCase(pairs, players).execute({ pairId: pair.id, managerId: ManagerId('m1') })).rejects.toThrow(
      /cannot accept/,
    );
    expect((await pairs.findById(pair.id))!.isPending).toBe(true);
  });

  it('rejects accepting a pair that is not pending', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    const active = DoublesPair.activate(PairId('p-active'), PlayerId('a'), PlayerId('b'));
    await pairs.save(active);

    await expect(
      new AcceptDoublesPairUseCase(pairs, players).execute({ pairId: active.id, managerId: ManagerId('m1') }),
    ).rejects.toThrow(/not awaiting acceptance/);
  });

  it('re-verifies the one-active-pair invariant at acceptance — refuses when a player is already in another pair', async () => {
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await players.save(makePlayer(PlayerId('a'), ManagerId('m1')));
    await players.save(makePlayer(PlayerId('b'), ManagerId('m2')));
    await players.save(makePlayer(PlayerId('c'), ManagerId('m1')));

    // 'a' is already ACTIVE with 'c' — hand-seeded, since the create path
    // would itself refuse to add a second pair for 'a'.
    await pairs.save(DoublesPair.activate(PairId('p-active'), PlayerId('a'), PlayerId('c')));
    // ...while a stale PENDING invite ('a' + 'b') still sits around.
    const pending = DoublesPair.propose(PairId('p-pending'), PlayerId('a'), PlayerId('b'));
    await pairs.save(pending);

    await expect(
      new AcceptDoublesPairUseCase(pairs, players).execute({ pairId: pending.id, managerId: ManagerId('m2') }),
    ).rejects.toThrow(/already in another doubles pair/);
    expect((await pairs.findById(pending.id))!.isPending).toBe(true);
  });
});
