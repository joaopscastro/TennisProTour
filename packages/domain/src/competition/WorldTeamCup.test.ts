import { describe, expect, it } from 'vitest';
import { WorldTeamCup, WorldTeamCupTie } from './WorldTeamCup';
import { PairId, PlayerId, TournamentId } from '../shared/ids';

const COUNTRIES = ['BR', 'US', 'ES', 'FR', 'GB', 'DE', 'IT', 'AR'];

function makeCup(): WorldTeamCup {
  return WorldTeamCup.open({
    id: TournamentId('wtc1'),
    season: 1,
    weekScheduled: { season: 1, week: 42 },
    surface: 'clay',
    teams: COUNTRIES.map((country, i) => ({
      country,
      players: [PlayerId(`${country}-p1`), PlayerId(`${country}-p2`)],
    })),
  });
}

function playRubber(tie: WorldTeamCupTie, rubberIndex: number): void {
  const rubber = tie.rubbers[rubberIndex];
  const winner = rubber.kind === 'singles' ? rubber.playerA : rubber.pairA;
  const loser = rubber.kind === 'singles' ? rubber.playerB : rubber.pairB;
  const cup = makeCup; // not used, just to avoid unused warning
  void cup;
  tie.rubbers[rubberIndex].outcome = { winner, loser, setScores: [{ winnerGames: 6, loserGames: 2 }] } as never;
}

describe('WorldTeamCup', () => {
  it('opens with two groups of four and pairwise ties', () => {
    const cup = makeCup();
    expect(cup.groups).toHaveLength(2);
    expect(cup.groups[0].ties).toHaveLength(6);
    expect(cup.groups[0].teams).toHaveLength(4);
  });

  it('a tie is decided at 2-0 without playing the doubles rubber', () => {
    const cup = makeCup();
    const tie = cup.groups[0].ties[0];
    // teamA wins both singles: 2-0.
    cup.recordRubberOutcome(tie, 0, { winner: (tie.rubbers[0] as { playerA: PlayerId }).playerA, loser: (tie.rubbers[0] as { playerB: PlayerId }).playerB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
    cup.recordRubberOutcome(tie, 1, { winner: (tie.rubbers[1] as { playerA: PlayerId }).playerA, loser: (tie.rubbers[1] as { playerB: PlayerId }).playerB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
    expect(tie.winner).toBe(tie.teamA);
    expect(cup.nextDueRubberIndex(tie)).toBeNull(); // decided, no doubles needed
  });

  it('plays the doubles rubber when the singles split 1-1', () => {
    const cup = makeCup();
    const tie = cup.groups[0].ties[0];
    cup.recordRubberOutcome(tie, 0, { winner: (tie.rubbers[0] as { playerA: PlayerId }).playerA, loser: (tie.rubbers[0] as { playerB: PlayerId }).playerB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
    cup.recordRubberOutcome(tie, 1, { winner: (tie.rubbers[1] as { playerB: PlayerId }).playerB, loser: (tie.rubbers[1] as { playerA: PlayerId }).playerA, setScores: [{ winnerGames: 6, loserGames: 2 }] });
    expect(tie.winner).toBeNull();
    expect(cup.nextDueRubberIndex(tie)).toBe(2); // doubles due
    const d = tie.rubbers[2] as { pairA: PairId; pairB: PairId };
    expect(cup.doublesPlayersFor(d.pairA)).toHaveLength(2);
  });

  it('seeds the knockout from group standings and crowns a champion', () => {
    const cup = makeCup();
    // Play every group tie: teamA (first listed) wins 2-0.
    for (const group of cup.groups) {
      for (const tie of group.ties) {
        cup.recordRubberOutcome(tie, 0, { winner: (tie.rubbers[0] as { playerA: PlayerId }).playerA, loser: (tie.rubbers[0] as { playerB: PlayerId }).playerB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
        cup.recordRubberOutcome(tie, 1, { winner: (tie.rubbers[1] as { playerA: PlayerId }).playerA, loser: (tie.rubbers[1] as { playerB: PlayerId }).playerB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
      }
    }
    expect(cup.allGroupStagesComplete).toBe(true);
    cup.seedKnockout();
    expect(cup.knockout).toHaveLength(1);
    expect(cup.knockout[0]).toHaveLength(2);

    // Decide both semis (teamA wins), then advance to the final.
    for (const tie of cup.knockout[0]) {
      cup.recordRubberOutcome(tie, 0, { winner: (tie.rubbers[0] as { playerA: PlayerId }).playerA, loser: (tie.rubbers[0] as { playerB: PlayerId }).playerB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
      cup.recordRubberOutcome(tie, 1, { winner: (tie.rubbers[1] as { playerA: PlayerId }).playerA, loser: (tie.rubbers[1] as { playerB: PlayerId }).playerB, setScores: [{ winnerGames: 6, loserGames: 2 }] });
    }
    cup.advanceKnockout();
    expect(cup.knockout).toHaveLength(2);
  });

  it('breaks a 2-way ties-won tie by head-to-head, not by stable array order', () => {
    const cup = makeCup();
    // Snake seeding puts [BR, FR, GB, AR] in group 0. Play it so BR and FR
    // both finish 2-1, but FR beat BR head-to-head — BR is listed FIRST in
    // the group, so a ties-won-only stable sort (the pre-fix behavior) would
    // wrongly rank BR ahead of FR.
    const group = cup.groups[0];
    const findTie = (a: string, b: string) =>
      group.ties.find((t) => (t.teamA === a && t.teamB === b) || (t.teamA === b && t.teamB === a))!;
    const winTie = (a: string, b: string, winner: string) => {
      const tie = findTie(a, b);
      for (let r = 0; r < 2; r++) {
        const rubber = tie.rubbers[r] as { playerA: PlayerId; playerB: PlayerId };
        const teamAWon = tie.teamA === winner;
        cup.recordRubberOutcome(tie, r, {
          winner: teamAWon ? rubber.playerA : rubber.playerB,
          loser: teamAWon ? rubber.playerB : rubber.playerA,
          setScores: [{ winnerGames: 6, loserGames: 2 }],
        });
      }
    };

    winTie('BR', 'FR', 'FR'); // head-to-head: FR beats BR
    winTie('BR', 'GB', 'BR');
    winTie('BR', 'AR', 'BR');
    winTie('FR', 'GB', 'FR');
    winTie('FR', 'AR', 'AR');
    winTie('GB', 'AR', 'GB');

    const standings = cup.groupStandings(group);
    // FR (2-1, beat BR) must outrank BR (2-1, lost to FR) despite BR being
    // listed first in the group.
    expect(standings.indexOf('FR')).toBeLessThan(standings.indexOf('BR'));
    expect(standings.slice(0, 2).sort()).toEqual(['BR', 'FR']);
  });
});
