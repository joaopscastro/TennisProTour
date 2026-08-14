import { PairId, PlayerId, TournamentId } from '../shared/ids';
import { TournamentDoublesPair } from './CompetitionTypes';
import { RandomSource } from '../match-simulation/MatchSimulator';

export interface DoublesPairingInput {
  tournamentId: TournamentId;
  /** Every player who signed up for this tournament's doubles field
   * (solo entrants — doubles entry is per-player, not per-pair). */
  entrants: PlayerId[];
  /** Each involved player's doubles ENTRY ranking (see
   * DoublesRanking.doublesEntryRanking — doubles total, else singles),
   * pre-computed by the caller. Entrants and free-agent fillers are both
   * looked up here; a missing key reads as 0. */
  entryRanking: Map<PlayerId, number>;
  /** Active persistent partnerships (P7a) among the entrants — pairs
   * whose BOTH members entered stay together rather than being
   * randomized, carrying their own id + chemistry (P7c) onto the formed
   * pair so the sim can use it and the match can grow it. */
  persistentPairs: Array<{ playerA: PlayerId; playerB: PlayerId; pairId: PairId; chemistry: number }>;
  /** Available manager-less players to pair an odd leftover entrant
   * with (free agents/fill-only), in no particular order — the service
   * picks one at random. */
  freeAgentFillers: PlayerId[];
  /** How many pairs the doubles bracket holds — the cutoff. */
  drawSize: number;
  random: RandomSource;
}

export interface DoublesPairingResult {
  /** Every pair formed, sorted by combined ranking descending (ties
   * broken by pairId for determinism). */
  pairs: RankedDoublesPair[];
  /** The top `drawSize` pairs by combined ranking — these seed the
   * bracket. */
  accepted: RankedDoublesPair[];
  /** The rest — genuinely cut, they do not play. */
  cut: RankedDoublesPair[];
}

/** A formed pair plus its combined ranking (the sum of the two players'
 * entry rankings) — the extra field only exists here at formation time
 * to drive the sort/cut; it is deliberately NOT stored on the
 * tournament (it's derivable from the two players' rankings). */
export interface RankedDoublesPair extends TournamentDoublesPair {
  combinedRanking: number;
}

interface FormedPair {
  playerA: PlayerId;
  playerB: PlayerId;
  chemistry: number;
  persistentPairId?: PairId;
}

/**
 * Forms a tournament's doubles pairs from its solo entrants (P7b) — the
 * pure, deterministic-given-a-RandomSource counterpart to BracketGenerator
 * that turns "who signed up" into "who actually plays, and with whom":
 *
 * 1. Persistent partnerships win: two entrants already in an active
 *    `DoublesPair` are paired together (the P7a value — a known partner,
 *    chemistry later in P7c).
 * 2. Everyone else is randomly shuffled and paired two-by-two.
 * 3. An odd leftover is paired with a random free-agent filler (if one is
 *    available; otherwise they're simply dropped — there is no
 *    half-pair).
 * 4. Each pair's combined ranking is the SUM of the two players' entry
 *    rankings (see DoublesRanking.doublesEntryRanking), and only the top
 *    `drawSize` make the bracket — the rest are cut.
 *
 * `pairId`s are tournament-local (`<tournamentId>-d<index>`), distinct
 * from a persistent `DoublesPair`'s own id: a persistent pair is only a
 * *hint* that these two should play together, not the identity of this
 * tournament's slot.
 */
export class DoublesPairingService {
  pair(input: DoublesPairingInput): DoublesPairingResult {
    const remaining = new Set(input.entrants);
    const formed: FormedPair[] = [];

    for (const p of input.persistentPairs) {
      if (p.playerA !== p.playerB && remaining.has(p.playerA) && remaining.has(p.playerB)) {
        formed.push({ playerA: p.playerA, playerB: p.playerB, chemistry: p.chemistry, persistentPairId: p.pairId });
        remaining.delete(p.playerA);
        remaining.delete(p.playerB);
      }
    }

    const solo = DoublesPairingService.shuffle([...remaining], input.random);
    for (let i = 0; i + 1 < solo.length; i += 2) {
      formed.push({ playerA: solo[i], playerB: solo[i + 1], chemistry: 0 });
    }
    if (solo.length % 2 === 1) {
      const filler = DoublesPairingService.pick(solo[solo.length - 1], input.freeAgentFillers, input.random);
      if (filler) formed.push({ playerA: solo[solo.length - 1], playerB: filler, chemistry: 0 });
    }

    const rankingOf = (id: PlayerId): number => input.entryRanking.get(id) ?? 0;
    const pairs: RankedDoublesPair[] = formed
      .map((p, index) => ({
        pairId: PairId(`${input.tournamentId}-d${index}`),
        playerA: p.playerA,
        playerB: p.playerB,
        chemistry: p.chemistry,
        persistentPairId: p.persistentPairId,
        combinedRanking: rankingOf(p.playerA) + rankingOf(p.playerB),
      }))
      .sort((a, b) => (b.combinedRanking - a.combinedRanking) || a.pairId.localeCompare(b.pairId));

    return {
      pairs,
      accepted: pairs.slice(0, input.drawSize),
      cut: pairs.slice(input.drawSize),
    };
  }

  private static shuffle<T>(items: T[], random: RandomSource): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random.next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /** Picks one free-agent filler at random for the given leftover
   * entrant, or null when none are available (the leftover is dropped). */
  private static pick(leftover: PlayerId, fillers: PlayerId[], random: RandomSource): PlayerId | null {
    const available = fillers.filter((f) => f !== leftover);
    if (available.length === 0) return null;
    return available[Math.min(available.length - 1, Math.floor(random.next() * available.length))];
  }
}
