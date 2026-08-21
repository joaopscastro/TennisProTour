import { describe, expect, it } from 'vitest';
import { PlayerId } from '../shared/ids';
import { StandardSeasonBonusPoolPolicy } from './SeasonBonusPoolPolicy';

describe('StandardSeasonBonusPoolPolicy', () => {
  const policy = new StandardSeasonBonusPoolPolicy();

  it('pays the top 10 standings by season points, most points first', () => {
    const standings = [
      { playerId: PlayerId('p1'), points: 500 },
      { playerId: PlayerId('p2'), points: 2000 },
      { playerId: PlayerId('p3'), points: 1200 },
    ];
    const payouts = policy.computePayouts(standings);
    expect(payouts).toHaveLength(3);
    expect(payouts[0]).toMatchObject({ playerId: PlayerId('p2'), rank: 1 });
    expect(payouts[1]).toMatchObject({ playerId: PlayerId('p3'), rank: 2 });
    expect(payouts[2]).toMatchObject({ playerId: PlayerId('p1'), rank: 3 });
  });

  it('pays rank 1 strictly more than rank 2, and every payout is positive', () => {
    const standings = [
      { playerId: PlayerId('p1'), points: 2000 },
      { playerId: PlayerId('p2'), points: 1000 },
    ];
    const payouts = policy.computePayouts(standings);
    expect(payouts[0].amount).toBeGreaterThan(payouts[1].amount);
    for (const payout of payouts) expect(payout.amount).toBeGreaterThan(0);
  });

  it('never pays more than 10 players, however many are ranked', () => {
    const standings = Array.from({ length: 25 }, (_, i) => ({ playerId: PlayerId(`p${i}`), points: 25 - i }));
    const payouts = policy.computePayouts(standings);
    expect(payouts).toHaveLength(10);
    expect(payouts.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('never pays a player with zero season points, even if fewer than 10 players are eligible', () => {
    const standings = [
      { playerId: PlayerId('p1'), points: 100 },
      { playerId: PlayerId('p2'), points: 0 },
      { playerId: PlayerId('p3'), points: 0 },
    ];
    const payouts = policy.computePayouts(standings);
    expect(payouts).toHaveLength(1);
    expect(payouts[0].playerId).toBe(PlayerId('p1'));
  });

  it('breaks an exact points tie deterministically by playerId', () => {
    const standings = [
      { playerId: PlayerId('pZ'), points: 100 },
      { playerId: PlayerId('pA'), points: 100 },
    ];
    const payouts = policy.computePayouts(standings);
    expect(payouts[0].playerId).toBe(PlayerId('pA'));
    expect(payouts[1].playerId).toBe(PlayerId('pZ'));
  });

  it('returns an empty payout list for empty standings', () => {
    expect(policy.computePayouts([])).toEqual([]);
  });
});
