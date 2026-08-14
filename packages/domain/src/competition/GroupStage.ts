import { PlayerId } from '../shared/ids';
import { MatchOutcome } from './CompetitionTypes';

/**
 * Round-robin group-stage primitives (P8b Masters Cup / P8c World Team
 * Cup) — the genuinely new bracket shape this game needs beyond
 * single-elimination. A group stage is a set of GROUPS, each a set of
 * entrants where everyone plays everyone once; its standings feed a
 * knockout stage. Generic over the slot id `S` (a PlayerId for singles,
 * a PairId for doubles) exactly like BracketRound.
 */

export interface GroupMatch<S extends string = PlayerId> {
  entrantA: S;
  entrantB: S;
  outcome: MatchOutcome<S> | null;
}

export interface Group<S extends string = PlayerId> {
  /** The entrants in this group, in seed order. */
  entrants: ReadonlyArray<S>;
  /** Every pairwise match in the group (groupSize choose 2). Mutable
   * (not readonly) so an aggregate recording outcomes can replace a
   * match in place. */
  matches: Array<GroupMatch<S>>;
}

export interface GroupStage<S extends string = PlayerId> {
  groups: ReadonlyArray<Group<S>>;
}

/** A group-stage result row — one entrant's record within one group. */
export interface GroupStanding<S extends string = PlayerId> {
  entrant: S;
  wins: number;
  /** Total SETS won (a 2-0 win = +2, a 2-1 win = +2/-1, a 0-2 loss = 0).
   * The tiebreak after wins. */
  setsWon: number;
  /** Total GAMES won, the tiebreak after sets. */
  gamesWon: number;
}

/**
 * Computes a group's standings, sorted ready for advancement. Ordering
 * (the real round-robin conventions): most wins first, then head-to-head
 * between two tied entrants (whoever won their direct match ranks
 * higher), then sets won, then games won. Pure and deterministic.
 */
export function groupStandings<S extends string>(group: Group<S>): GroupStanding<S>[] {
  const rows: GroupStanding<S>[] = group.entrants.map((entrant) => ({ entrant, wins: 0, setsWon: 0, gamesWon: 0 }));

  for (const match of group.matches) {
    if (!match.outcome) continue;
    const winner = rows.find((r) => r.entrant === match.outcome!.winner);
    const loser = rows.find((r) => r.entrant === match.outcome!.loser);
    if (!winner || !loser) continue;
    winner.wins += 1;
    // setScores is stored from the MATCH WINNER's perspective; a set is
    // won by whichever side has more games in it.
    for (const set of match.outcome.setScores) {
      const winnerWonSet = set.winnerGames > set.loserGames;
      if (winnerWonSet) winner.setsWon += 1;
      else loser.setsWon += 1;
      winner.gamesWon += set.winnerGames;
      loser.gamesWon += set.loserGames;
    }
  }

  return rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const headToHead = headToHeadWinner(a.entrant, b.entrant, group);
    if (headToHead === a.entrant) return -1;
    if (headToHead === b.entrant) return 1;
    if (b.setsWon !== a.setsWon) return b.setsWon - a.setsWon;
    return b.gamesWon - a.gamesWon;
  });
}

function headToHeadWinner<S extends string>(a: S, b: S, group: Group<S>): S | null {
  const match = group.matches.find(
    (m) => (m.entrantA === a && m.entrantB === b) || (m.entrantA === b && m.entrantB === a),
  );
  if (!match?.outcome) return null;
  return match.outcome.winner;
}
