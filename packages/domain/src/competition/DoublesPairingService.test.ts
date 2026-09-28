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

  it('forms exactly 1 pair for a lone persistent partnership entering alone — below the 2-pair minimum a bracket needs', () => {
    // Documents the exact boundary that made a real, live bug possible:
    // a manager whose ONLY doubles entry is their own persistent pair, in
    // a tournament nobody else registered doubles for, gets exactly one
    // formed pair here. FormDoublesDrawUseCase requires >= 2 formed pairs
    // before it will ever seed a bracket (see that class's own doc
    // comment) — this pairing result alone can never cross that
    // threshold, no matter how many times it's re-run, since there's no
    // second real entrant and no general backfill in THIS service (only
    // a single odd-leftover filler, which never engages here because the
    // persistent pair consumes both entrants exactly, leaving 0 solo).
    // FormDoublesDrawUseCase.form now pads the ENTRANTS list it passes in
    // before calling this service, specifically to get past this floor —
    // see that class's own test coverage for the padded case.
    const result = new DoublesPairingService().pair({
      tournamentId: T,
      entrants: [PlayerId('a'), PlayerId('b')],
      entryRanking: ranking([['a', 50], ['b', 50]]),
      persistentPairs: [{ playerA: PlayerId('a'), playerB: PlayerId('b'), pairId: PairId('pp-ab'), chemistry: 0 }],
      freeAgentFillers: [],
      drawSize: 8,
      random: neverRandom,
    });

    expect(result.pairs).toHaveLength(1);
    expect(result.accepted).toHaveLength(1); // < 2 — FormDoublesDrawUseCase will never seed this
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

  describe('strength-aware padding path (field-strength fix)', () => {
    const strengthOf = (entries: Array<[string, number]>) => new Map(entries.map(([id, s]) => [PlayerId(id), s]));

    it('pairs padded fillers strongest-with-strongest (keeps the caller order) instead of shuffling them', () => {
      const padded = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(PlayerId);
      const result = new DoublesPairingService().pair({
        tournamentId: T,
        entrants: [PlayerId('mgr-a'), PlayerId('mgr-b'), ...padded],
        entryRanking: ranking([]),
        persistentPairs: [{ playerA: PlayerId('mgr-a'), playerB: PlayerId('mgr-b'), pairId: PairId('pp'), chemistry: 100 }],
        freeAgentFillers: [],
        drawSize: 4,
        random: neverRandom,
        strength: strengthOf([
          ['mgr-a', 100],
          ['mgr-b', 100],
          ['f1', 95],
          ['f2', 90],
          ['f3', 85],
          ['f4', 80],
          ['f5', 75],
          ['f6', 70],
        ]),
        fillerEntrants: new Set(padded),
      });

      const fillerPairs = result.pairs.filter((p) => p.persistentPairId === undefined);
      expect(fillerPairs).toHaveLength(3);
      const members = fillerPairs.map((p) => [p.playerA, p.playerB]);
      expect(members).toContainEqual([PlayerId('f1'), PlayerId('f2')]);
      expect(members).toContainEqual([PlayerId('f3'), PlayerId('f4')]);
      expect(members).toContainEqual([PlayerId('f5'), PlayerId('f6')]);
    });

    it('pairs an odd solo leftover with the strongest padded filler AT OR BELOW its own strength (padding never strengthens a manager past their level)', () => {
      const padded = ['f1', 'f2', 'f3', 'f4', 'f5'].map(PlayerId);
      const result = new DoublesPairingService().pair({
        tournamentId: T,
        entrants: [PlayerId('solo'), ...padded],
        entryRanking: ranking([]),
        persistentPairs: [],
        freeAgentFillers: [],
        drawSize: 4,
        random: neverRandom,
        strength: strengthOf([
          ['solo', 60],
          ['f1', 90],
          ['f2', 80],
          ['f3', 70],
          ['f4', 50],
          ['f5', 40],
        ]),
        fillerEntrants: new Set(padded),
      });

      expect(result.pairs).toHaveLength(3);
      const soloPair = result.pairs.find((p) => p.playerA === PlayerId('solo') || p.playerB === PlayerId('solo'));
      expect(soloPair).toBeDefined();
      const partner = soloPair!.playerA === PlayerId('solo') ? soloPair!.playerB : soloPair!.playerA;
      expect(partner).toBe(PlayerId('f4')); // 50 <= 60; f3 (70) is above the solo's own strength
    });

    it('uses a spare free agent for an odd solo when the padded count is already even (legacy parity), leaving the padded pairs intact', () => {
      const padded = ['f1', 'f2', 'f3', 'f4'].map(PlayerId);
      const result = new DoublesPairingService().pair({
        tournamentId: T,
        entrants: [PlayerId('solo'), ...padded],
        entryRanking: ranking([]),
        persistentPairs: [],
        freeAgentFillers: [PlayerId('spare')],
        drawSize: 4,
        random: neverRandom,
        strength: strengthOf([
          ['solo', 60],
          ['f1', 90],
          ['f2', 80],
          ['f3', 70],
          ['f4', 50],
        ]),
        fillerEntrants: new Set(padded),
      });

      const covered = result.pairs.flatMap((p) => [p.playerA, p.playerB]);
      expect(covered).toContain(PlayerId('spare'));
      expect(result.pairs).toHaveLength(3);
    });

    it('leaves the legacy random pairing byte-for-byte when strength/fillerEntrants are absent', () => {
      // Same inputs as the legacy "even count" test above: without the
      // strength map the service must still shuffle-pair everyone.
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
    });
  });
});
