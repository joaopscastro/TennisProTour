import { describe, expect, it } from 'vitest';
import { MastersCup } from './MastersCup';
import { PairId, PlayerId, TournamentId } from '../shared/ids';

function makeCup(): MastersCup {
  return MastersCup.open({
    id: TournamentId('mc1'),
    season: 1,
    weekScheduled: { season: 1, week: 40 },
    surface: 'hard',
    singlesEntrants: Array.from({ length: 8 }, (_, i) => PlayerId(`p${i + 1}`)),
    doublesEntrants: Array.from({ length: 8 }, (_, i) => ({
      pairId: PairId(`d${i + 1}`),
      playerA: PlayerId(`pa${i + 1}`),
      playerB: PlayerId(`pb${i + 1}`),
    })),
  });
}

function playGroup(cup: MastersCup): void {
  // Every group match: the seed-order-entrant A beats entrant B.
  for (let g = 0; g < 2; g++) {
    const group = cup.singlesGroups[g];
    for (let m = 0; m < group.matches.length; m++) {
      const match = group.matches[m];
      cup.recordSinglesGroupMatchOutcome(g, m, {
        winner: match.entrantA,
        loser: match.entrantB,
        setScores: [{ winnerGames: 6, loserGames: 2 }],
      });
    }
  }
  for (let g = 0; g < 2; g++) {
    const group = cup.doublesGroups[g];
    for (let m = 0; m < group.matches.length; m++) {
      const match = group.matches[m];
      cup.recordDoublesGroupMatchOutcome(g, m, {
        winner: match.entrantA,
        loser: match.entrantB,
        setScores: [{ winnerGames: 6, loserGames: 2 }],
      });
    }
  }
}

describe('MastersCup', () => {
  it('opens with two groups of four per discipline', () => {
    const cup = makeCup();
    expect(cup.singlesGroups).toHaveLength(2);
    expect(cup.singlesGroups[0].matches).toHaveLength(6);
    expect(cup.doublesGroups).toHaveLength(2);
    expect(cup.hasKnockout).toBe(false);
  });

  it('does not seed the knockout until both group stages are complete', () => {
    const cup = makeCup();
    expect(() => cup.seedKnockout()).toThrow(/both group stages/);
  });

  it('seeds the knockout from the top 2 per group and crowns champions', () => {
    const cup = makeCup();
    playGroup(cup);
    expect(cup.singlesGroupStageComplete).toBe(true);
    expect(cup.doublesGroupStageComplete).toBe(true);

    cup.seedKnockout();
    expect(cup.hasKnockout).toBe(true);
    expect(cup.singlesKnockout).toHaveLength(1); // semis; final added lazily
    expect(cup.singlesSemifinalists()).toHaveLength(4);

    // Play the two semis: first entrant wins each.
    const semis = cup.singlesKnockout[0];
    for (let i = 0; i < semis.matches.length; i++) {
      cup.recordSinglesKnockoutMatchOutcome(1, i, {
        winner: semis.matches[i].entrantA,
        loser: semis.matches[i].entrantB,
        setScores: [{ winnerGames: 6, loserGames: 2 }],
      });
    }
    expect(cup.singlesKnockout).toHaveLength(2); // final added
    const final = cup.singlesKnockout[1];
    cup.recordSinglesKnockoutMatchOutcome(2, 0, {
      winner: final.matches[0].entrantA,
      loser: final.matches[0].entrantB,
      setScores: [{ winnerGames: 6, loserGames: 2 }],
    });

    expect(cup.singlesKnockoutComplete).toBe(true);
    expect(cup.singlesChampion).toBe(final.matches[0].entrantA);
  });

  it('pairs the two semifinals ACROSS groups, never intra-group rematches', () => {
    const cup = makeCup();
    playGroup(cup);

    const g1 = new Set(cup.singlesGroups[0].entrants);
    const g2 = new Set(cup.singlesGroups[1].entrants);

    cup.seedKnockout();
    const semis = cup.singlesKnockout[0];
    expect(semis.matches).toHaveLength(2);
    for (const m of semis.matches) {
      const aInG1 = g1.has(m.entrantA);
      const bInG1 = g1.has(m.entrantB);
      // Each semifinal pairs one group-1 entrant against one group-2 entrant.
      expect(aInG1).not.toBe(bInG1);
    }
  });
});
