import { describe, expect, it } from 'vitest';
import { DoublesPair } from './DoublesPair';
import { PairId, PlayerId } from '../shared/ids';

const A = PlayerId('a');
const B = PlayerId('b');

describe('DoublesPair', () => {
  it('propose starts pending', () => {
    const pair = DoublesPair.propose(PairId('p1'), A, B);
    expect(pair.isPending).toBe(true);
    expect(pair.isActive).toBe(false);
    expect(pair.isDissolved).toBe(false);
  });

  it('activate starts active', () => {
    const pair = DoublesPair.activate(PairId('p1'), A, B);
    expect(pair.isActive).toBe(true);
    expect(pair.isPending).toBe(false);
  });

  it('rejects a pair of a player with themselves', () => {
    expect(() => DoublesPair.propose(PairId('p1'), A, A)).toThrow(/distinct/);
    expect(() => DoublesPair.activate(PairId('p1'), A, A)).toThrow(/distinct/);
  });

  it('accept moves pending -> active', () => {
    const pair = DoublesPair.propose(PairId('p1'), A, B);
    pair.accept();
    expect(pair.isActive).toBe(true);
  });

  it('accept on a non-pending pair throws', () => {
    const active = DoublesPair.activate(PairId('p1'), A, B);
    expect(() => active.accept()).toThrow(/not pending/);

    const dissolved = DoublesPair.propose(PairId('p2'), A, B);
    dissolved.dissolve();
    expect(() => dissolved.accept()).toThrow(/not pending/);
  });

  it('dissolve ends both pending and active pairs, idempotently', () => {
    const pending = DoublesPair.propose(PairId('p1'), A, B);
    pending.dissolve();
    expect(pending.isDissolved).toBe(true);
    pending.dissolve(); // idempotent
    expect(pending.isDissolved).toBe(true);

    const active = DoublesPair.activate(PairId('p2'), A, B);
    active.dissolve();
    expect(active.isDissolved).toBe(true);
  });

  it('involves/partnerOf answer membership', () => {
    const pair = DoublesPair.propose(PairId('p1'), A, B);
    expect(pair.involves(A)).toBe(true);
    expect(pair.involves(B)).toBe(true);
    expect(pair.involves(PlayerId('c'))).toBe(false);
    expect(pair.partnerOf(A)).toBe(B);
    expect(pair.partnerOf(B)).toBe(A);
    expect(pair.partnerOf(PlayerId('c'))).toBeNull();
  });

  it('reconstitute restores status with no transition', () => {
    const pair = DoublesPair.reconstitute({ id: PairId('p1'), playerA: A, playerB: B, status: 'active' });
    expect(pair.isActive).toBe(true);
  });

  it('tracks chemistry (P7c), gained by playing together and clamped to 100', () => {
    const pair = DoublesPair.activate(PairId('p1'), A, B);
    expect(pair.chemistry).toBe(0);
    pair.gainChemistry(1);
    expect(pair.chemistry).toBe(1);
    pair.gainChemistry(200);
    expect(pair.chemistry).toBe(100);
  });
});
