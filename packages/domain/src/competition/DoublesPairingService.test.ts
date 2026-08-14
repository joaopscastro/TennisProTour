import { describe, expect, it } from 'vitest';
import { DoublesPairingService } from './DoublesPairingService';
import { PairId, PlayerId, TournamentId } from '../shared/ids';
import { RandomSource } from '../match-simulation/MatchSimulator';

const T = TournamentId('t1');

function ranking(entries: Array<[string, number]>): Map<PlayerId, number> {
  return new Map(entries.map(([id, pts]) => [PlayerId(id), pts]));
}

const neverRandom: RandomSource = { next: () => 0.5 };

describe('DoublesPairingService', () => {
  it('keeps both members of a persistent partnership together', () => {
    const result = new DoublesPairingService().pair({
      tournamentId: T,
      entrants: [PlayerId('a'), PlayerId('b'), PlayerId('c'), PlayerId('d')],
      entryRanking: ranking([['a', 100], ['b', 100], ['c', 10], ['d', 10]]),
      persistentPairs: [{ playerA: PlayerId('a'), playerB: PlayerId('b'), pairId: PairId('pp-ab'), chemistry: 42 }],
      freeAgentFillers: [],
      drawSize: 4,
      random: neverRandom,
    });

    const ab = result.pairs.find((p) => p.pairId.includes('d0'));
    expect(ab).toBeDefined();
    expect([ab!.playerA, ab!.playerB].sort()).toEqual([PlayerId('a'), PlayerId('b')]);
  });

  it('randomly pairs solo entrants two-by-two, covering everyone (even count)', () => {
    const result = new DoublesPairingService().pair({
      tournamentId: T,
      entrants: [PlayerId('a'), PlayerId('b'), PlayerId('c'), PlayerId('d')],
      entryRanking: ranking([['a', 1], ['b', 2], ['c', 3], ['d', 4]]),
      persistentPairs: [],
      freeAgentFillers: [],
      drawSize: 4,
      random: neverRandom,
    });

    expect(result.pairs).toHaveLength(2);
    const covered = result.pairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(new Set(covered).size).toBe(4);
  });

  it('pairs an odd leftover solo entrant with a free-agent filler', () => {
    const result = new DoublesPairingService().pair({
      tournamentId: T,
      entrants: [PlayerId('a'), PlayerId('b'), PlayerId('c')],
      entryRanking: ranking([['a', 1], ['b', 2], ['c', 3]]),
      persistentPairs: [],
      freeAgentFillers: [PlayerId('fa1')],
      drawSize: 4,
      random: neverRandom,
    });

    expect(result.pairs).toHaveLength(2);
    const covered = result.pairs.flatMap((p) => [p.playerA, p.playerB]);
    expect(covered).toContain(PlayerId('fa1'));
  });

  it('drops an odd leftover solo entrant when no free-agent filler is available', () => {
    const result = new DoublesPairingService().pair({
      tournamentId: T,
      entrants: [PlayerId('a'), PlayerId('b'), PlayerId('c')],
      entryRanking: ranking([['a', 1], ['b', 2], ['c', 3]]),
      persistentPairs: [],
      freeAgentFillers: [],
      drawSize: 4,
      random: neverRandom,
    });

    expect(result.pairs).toHaveLength(1); // only a+b; c is dropped
  });

  it('cuts to drawSize by combined ranking (sum of the two entry rankings)', () => {
    const result = new DoublesPairingService().pair({
      tournamentId: T,
      entrants: [PlayerId('a1'), PlayerId('a2'), PlayerId('b1'), PlayerId('b2'), PlayerId('c1'), PlayerId('c2')],
      entryRanking: ranking([['a1', 100], ['a2', 100], ['b1', 80], ['b2', 80], ['c1', 10], ['c2', 10]]),
      persistentPairs: [
        { playerA: PlayerId('a1'), playerB: PlayerId('a2'), pairId: PairId('pp-a'), chemistry: 10 },
        { playerA: PlayerId('b1'), playerB: PlayerId('b2'), pairId: PairId('pp-b'), chemistry: 10 },
        { playerA: PlayerId('c1'), playerB: PlayerId('c2'), pairId: PairId('pp-c'), chemistry: 10 },
      ],
      freeAgentFillers: [],
      drawSize: 2,
      random: neverRandom,
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.cut).toHaveLength(1);
    // The 200 and 160 combined-ranking pairs make the cut; the 20 pair does not.
    const acceptedPlayers = result.accepted.flatMap((p) => [p.playerA, p.playerB]);
    expect(acceptedPlayers).toContain(PlayerId('a1'));
    expect(acceptedPlayers).toContain(PlayerId('b1'));
    expect(result.cut.flatMap((p) => [p.playerA, p.playerB])).toContain(PlayerId('c1'));
  });
});
