import { describe, expect, it } from 'vitest';
import { GroupStageGenerator } from './GroupStageGenerator';
import { groupStandings, Group } from './GroupStage';
import { PlayerId } from '../shared/ids';

function fourEntrantGroup(): Group<string> {
  const stage = new GroupStageGenerator().generate(
    Array.from({ length: 4 }, (_, i) => ({ playerId: PlayerId(`p${i + 1}`), seed: i + 1 })),
    4,
  );
  return stage.groups[0];
}

function setOutcome(group: Group<string>, winner: string, loser: string, winnerGames = 6, loserGames = 2): void {
  const m = group.matches.find(
    (x) => (x.entrantA === winner && x.entrantB === loser) || (x.entrantA === loser && x.entrantB === winner),
  );
  if (!m) throw new Error(`No match ${winner} vs ${loser}`);
  m.outcome = { winner: PlayerId(winner), loser: PlayerId(loser), setScores: [{ winnerGames, loserGames }] };
}

describe('GroupStageGenerator', () => {
  it('snake-seeds 8 entrants into 2 groups of 4 (seeds 1..8 → [1,4,5,8] / [2,3,6,7])', () => {
    const entrants = Array.from({ length: 8 }, (_, i) => ({ playerId: PlayerId(`p${i + 1}`), seed: i + 1 }));
    const stage = new GroupStageGenerator().generate(entrants, 4);

    expect(stage.groups).toHaveLength(2);
    expect(stage.groups[0].entrants).toEqual(['p1', 'p4', 'p5', 'p8']);
    expect(stage.groups[1].entrants).toEqual(['p2', 'p3', 'p6', 'p7']);
    // 4 choose 2 = 6 matches per group
    expect(stage.groups[0].matches).toHaveLength(6);
    expect(stage.groups[1].matches).toHaveLength(6);
  });
});

describe('groupStandings', () => {
  it('ranks by wins', () => {
    const group = fourEntrantGroup();
    setOutcome(group, 'p1', 'p2');
    setOutcome(group, 'p1', 'p3');
    setOutcome(group, 'p1', 'p4');
    setOutcome(group, 'p2', 'p3');
    setOutcome(group, 'p2', 'p4');
    setOutcome(group, 'p3', 'p4');

    const standings = groupStandings(group);
    expect(standings.map((s) => s.entrant)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(standings[0].wins).toBe(3);
    expect(standings[3].wins).toBe(0);
  });

  it('breaks a two-way wins tie by head-to-head', () => {
    const group = fourEntrantGroup();
    // p1 and p2 both beat p3 and p4 (2 wins each), but p2 beat p1 head-to-head.
    setOutcome(group, 'p1', 'p3');
    setOutcome(group, 'p1', 'p4');
    setOutcome(group, 'p2', 'p3');
    setOutcome(group, 'p2', 'p4');
    setOutcome(group, 'p2', 'p1');
    setOutcome(group, 'p3', 'p4');

    const standings = groupStandings(group);
    expect(standings[0].entrant).toBe('p2');
    expect(standings[1].entrant).toBe('p1');
  });

  it('tracks sets and games won', () => {
    const group = fourEntrantGroup();
    setOutcome(group, 'p1', 'p2', 6, 4); // p1 wins 2 sets? one set 6-4
    setOutcome(group, 'p1', 'p3');
    setOutcome(group, 'p1', 'p4');
    setOutcome(group, 'p2', 'p3');
    setOutcome(group, 'p2', 'p4');
    setOutcome(group, 'p3', 'p4');

    const standings = groupStandings(group);
    expect(standings[0].entrant).toBe('p1');
    expect(standings[0].gamesWon).toBeGreaterThan(0);
  });
});
