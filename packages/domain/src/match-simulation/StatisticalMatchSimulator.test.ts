import { describe, expect, it } from 'vitest';
import { StatisticalMatchSimulator } from './StatisticalMatchSimulator';
import { MatchParticipant, RandomSource } from './MatchSimulator';
import { PlayerAttributes, Skill, SurfaceAffinities } from '../player/PlayerAttributes';
import { PlayerId } from '../shared/ids';
import { isBreakOfServe, MatchPointEntry } from '../competition/CompetitionTypes';

/** Replays a fixed sequence of RandomSource values, cycling once
 * exhausted — matches the pattern used elsewhere in this codebase for
 * deterministic RNG stubs (e.g. FilesystemMatchLogStore.integration.test.ts). */
class ScriptedRandomSource implements RandomSource {
  private index = 0;

  constructor(private readonly values: number[]) {}

  next(): number {
    const value = this.values[this.index % this.values.length];
    this.index += 1;
    return value;
  }
}

// Two identically-rated participants make pointWinProbabilityA exactly
// 0.5 (ratingGap 0, sigmoid(0) = 0.5), so any value < 0.5 deterministically
// wins the point for A and any value >= 0.5 deterministically wins it
// for B — the whole point sequence becomes fully scriptable.
const A_WINS = 0.1;
const B_WINS = 0.9;

function equalParticipant(id: string): MatchParticipant {
  return {
    playerId: PlayerId(id),
    fatigue: 0,
    attributes: new PlayerAttributes({
      technical: { serve: Skill.of(50), forehand: Skill.of(50), backhand: Skill.of(50), volley: Skill.of(50) },
      physical: { speed: Skill.of(50), stamina: Skill.of(50), strength: Skill.of(50) },
      mental: { consistency: Skill.of(50), clutch: Skill.of(50) },
      surfaceAffinities: SurfaceAffinities.initial(),
    }),
  };
}

function simplify(points: MatchPointEntry[]) {
  return points.map((p) => ({ a: p.pointScoreA, b: p.pointScoreB, wonBy: p.wonBy }));
}

describe('StatisticalMatchSimulator', () => {
  it('plays a love game as four straight points with correctly progressing 0/15/30/40 labels', () => {
    const random = new ScriptedRandomSource([A_WINS, A_WINS, A_WINS, A_WINS]);
    const simulator = new StatisticalMatchSimulator(random);

    const { log } = simulator.simulate(equalParticipant('pA'), equalParticipant('pB'), 'hard');

    const game1 = log.points.filter((p) => p.setNumber === 1 && p.gameNumber === 1);
    expect(simplify(game1)).toEqual([
      { a: '0', b: '0', wonBy: 'A' },
      { a: '15', b: '0', wonBy: 'A' },
      { a: '30', b: '0', wonBy: 'A' },
      { a: '40', b: '0', wonBy: 'A' },
    ]);

    // offsetSeconds strictly increases point-by-point...
    for (let i = 1; i < game1.length; i++) {
      expect(game1[i].offsetSeconds).toBeGreaterThan(game1[i - 1].offsetSeconds);
    }
    // ...and the game-level rollup lands on the same offset as the
    // last point, since both come from the same running clock.
    expect(log.entries[0]).toMatchObject({ setNumber: 1, gamesForA: 1, gamesForB: 0, wonBy: 'A' });
    expect(log.entries[0].offsetSeconds).toBe(game1[game1.length - 1].offsetSeconds);
  });

  it('plays a deuce game through multiple advantage swings before resolving', () => {
    // 0-0 -> 40-0 (A romps) -> 40-40 deuce -> Ad A -> deuce -> Ad B ->
    // deuce -> Ad A -> Game A. Two genuine swings back to deuce before
    // it's finally decided.
    const wonBySequence: Array<'A' | 'B'> = ['A', 'A', 'A', 'B', 'B', 'B', 'A', 'B', 'B', 'A', 'A', 'A'];
    const random = new ScriptedRandomSource(wonBySequence.map((w) => (w === 'A' ? A_WINS : B_WINS)));
    const simulator = new StatisticalMatchSimulator(random);

    const { log } = simulator.simulate(equalParticipant('pA'), equalParticipant('pB'), 'clay');

    const game1 = log.points.filter((p) => p.setNumber === 1 && p.gameNumber === 1);
    expect(simplify(game1)).toEqual([
      { a: '0', b: '0', wonBy: 'A' },
      { a: '15', b: '0', wonBy: 'A' },
      { a: '30', b: '0', wonBy: 'A' },
      { a: '40', b: '0', wonBy: 'B' },
      { a: '40', b: '15', wonBy: 'B' },
      { a: '40', b: '30', wonBy: 'B' },
      { a: '40', b: '40', wonBy: 'A' }, // deuce -> Ad A
      { a: 'Ad', b: '40', wonBy: 'B' }, // Ad A -> deuce (swing 1)
      { a: '40', b: '40', wonBy: 'B' }, // deuce -> Ad B
      { a: '40', b: 'Ad', wonBy: 'A' }, // Ad B -> deuce (swing 2)
      { a: '40', b: '40', wonBy: 'A' }, // deuce -> Ad A
      { a: 'Ad', b: '40', wonBy: 'A' }, // Ad A -> Game A
    ]);

    // Never more than a 1-point gap in the raw labels once deuce is
    // reached — 'Ad' always resolves to either back-to-deuce or a won
    // game, never lingers or compounds.
    const deuceOnward = simplify(game1).slice(6);
    for (const { a, b } of deuceOnward) {
      expect(a === '40' || a === 'Ad').toBe(true);
      expect(b === '40' || b === 'Ad').toBe(true);
      expect(a === 'Ad' && b === 'Ad').toBe(false); // both can never hold advantage simultaneously
    }

    expect(log.entries[0]).toMatchObject({ setNumber: 1, gamesForA: 1, gamesForB: 0, wonBy: 'A' });
    expect(log.entries[0].offsetSeconds).toBe(game1[game1.length - 1].offsetSeconds);
  });

  it('plays a tiebreak point-by-point with literal running counts, not 0/15/30/40', () => {
    const loveGameFor = (winner: 'A' | 'B') => Array(4).fill(winner === 'A' ? A_WINS : B_WINS);
    const values = [
      // 12 games alternating love-game winners -> 6-6, forcing a tiebreak.
      ...loveGameFor('A'),
      ...loveGameFor('B'),
      ...loveGameFor('A'),
      ...loveGameFor('B'),
      ...loveGameFor('A'),
      ...loveGameFor('B'),
      ...loveGameFor('A'),
      ...loveGameFor('B'),
      ...loveGameFor('A'),
      ...loveGameFor('B'),
      ...loveGameFor('A'),
      ...loveGameFor('B'),
      // Tiebreak: A wins it 7-0.
      A_WINS,
      A_WINS,
      A_WINS,
      A_WINS,
      A_WINS,
      A_WINS,
      A_WINS,
    ];
    const random = new ScriptedRandomSource(values);
    const simulator = new StatisticalMatchSimulator(random);

    const { log } = simulator.simulate(equalParticipant('pA'), equalParticipant('pB'), 'grass');

    // A tiebreak is conventionally the set's 13th game.
    const tiebreak = log.points.filter((p) => p.setNumber === 1 && p.gameNumber === 13);
    expect(simplify(tiebreak)).toEqual([
      { a: '0', b: '0', wonBy: 'A' },
      { a: '1', b: '0', wonBy: 'A' },
      { a: '2', b: '0', wonBy: 'A' },
      { a: '3', b: '0', wonBy: 'A' },
      { a: '4', b: '0', wonBy: 'A' },
      { a: '5', b: '0', wonBy: 'A' },
      { a: '6', b: '0', wonBy: 'A' },
    ]);
    // Tiebreak labels are always plain numeric strings, never 'Ad'.
    for (const { a, b } of simplify(tiebreak)) {
      expect(a).not.toBe('Ad');
      expect(b).not.toBe('Ad');
      expect(Number.isNaN(Number(a))).toBe(false);
      expect(Number.isNaN(Number(b))).toBe(false);
    }

    // The set-deciding rollup entry: 12 regular games already recorded,
    // the tiebreak is the 13th and finishes the set 7-6.
    expect(log.entries[12]).toMatchObject({ setNumber: 1, gamesForA: 7, gamesForB: 6, wonBy: 'A' });
    expect(log.entries[12].offsetSeconds).toBe(tiebreak[tiebreak.length - 1].offsetSeconds);
  });

  it('alternates the server every game, continuously across the match, with isBreakOfServe flagging exactly the games the receiver won', () => {
    // A repeating 4-game love-game cycle (A, A, B, B) — chosen so the
    // set score is never tied at a 4-game cycle boundary once the
    // leader can reach 6 with a 2-game margin, giving a fully
    // deterministic, finite first set: A wins it 6-4 in 10 games.
    // Server, by contrast, never depends on the scripted values at
    // all — it's pure alternation by cumulative game count — so this
    // same script also proves the two are independent: winner and
    // server agree on some games (holds) and disagree on others
    // (breaks), exactly where the arithmetic below predicts.
    const loveGameFor = (winner: 'A' | 'B') => Array(4).fill(winner === 'A' ? A_WINS : B_WINS);
    const cycle = [...loveGameFor('A'), ...loveGameFor('A'), ...loveGameFor('B'), ...loveGameFor('B')];
    const random = new ScriptedRandomSource(cycle);
    const simulator = new StatisticalMatchSimulator(random);

    const { log } = simulator.simulate(equalParticipant('pA'), equalParticipant('pB'), 'hard');

    const set1 = log.entries.filter((e) => e.setNumber === 1);
    // Server alternates A/B/A/B/... purely by position — independent
    // of who actually wins each game.
    expect(set1.map((e) => e.server)).toEqual(['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
    expect(set1.map((e) => e.wonBy)).toEqual(['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'A']);
    expect(set1[set1.length - 1]).toMatchObject({ gamesForA: 6, gamesForB: 4 }); // set won 6-4

    // isBreakOfServe agrees with a plain wonBy !== server check for
    // every single game, not just the ones that happen to be holds.
    const breaks = set1.map((e) => isBreakOfServe(e));
    expect(breaks).toEqual([false, true, true, false, false, true, true, false, false, true]);
    for (const entry of set1) {
      expect(isBreakOfServe(entry)).toBe(entry.wonBy !== entry.server);
    }

    // Server carries over continuously into set 2 rather than
    // resetting: set 1 used exactly 10 games (even), so set 2's first
    // game continues the alternation at 'A', picking up exactly where
    // set 1's 10th game (server 'B') left off.
    const set2 = log.entries.filter((e) => e.setNumber === 2);
    expect(set2[0].server).toBe('A');
  });
});
