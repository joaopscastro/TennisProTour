import { describe, expect, it } from 'vitest';
import { PlayerId } from '../shared/ids';
import { TournamentEntrant } from './CompetitionTypes';
import { BracketGenerator } from './BracketGenerator';

function entrant(seed: number, id: string): TournamentEntrant {
  return { playerId: PlayerId(id), seed };
}

describe('BracketGenerator', () => {
  const generator = new BracketGenerator();

  it('seeds a full 16-draw with no byes using standard bracket placement', () => {
    const entrants = Array.from({ length: 16 }, (_, i) => entrant(i + 1, `seed-${i + 1}`));

    const rounds = generator.generate(entrants, 16);

    expect(rounds).toHaveLength(1);
    const [round1] = rounds;
    expect(round1.roundNumber).toBe(1);
    expect(round1.matches).toHaveLength(8);
    expect(round1.matches.map((m) => [m.entrantA, m.entrantB])).toEqual([
      [PlayerId('seed-1'), PlayerId('seed-16')],
      [PlayerId('seed-8'), PlayerId('seed-9')],
      [PlayerId('seed-4'), PlayerId('seed-13')],
      [PlayerId('seed-5'), PlayerId('seed-12')],
      [PlayerId('seed-2'), PlayerId('seed-15')],
      [PlayerId('seed-7'), PlayerId('seed-10')],
      [PlayerId('seed-3'), PlayerId('seed-14')],
      [PlayerId('seed-6'), PlayerId('seed-11')],
    ]);
    expect(round1.matches.every((m) => m.outcome === null)).toBe(true);
  });

  it('gives byes to the top seeds when entrants fall short of the draw size', () => {
    const entrants = Array.from({ length: 10 }, (_, i) => entrant(i + 1, `seed-${i + 1}`));

    const [round1] = generator.generate(entrants, 16);

    // 6 byes (16 - 10) go to the top 6 seeds; only seeds 7-10 play round 1.
    expect(round1.matches).toHaveLength(2);
    expect(round1.matches.map((m) => [m.entrantA, m.entrantB])).toEqual([
      [PlayerId('seed-8'), PlayerId('seed-9')],
      [PlayerId('seed-7'), PlayerId('seed-10')],
    ]);

    const playingIds = new Set(round1.matches.flatMap((m) => [m.entrantA, m.entrantB]));
    for (let seed = 1; seed <= 6; seed++) {
      expect(playingIds.has(PlayerId(`seed-${seed}`))).toBe(false);
    }
  });

  it('throws when there are more entrants than the draw size', () => {
    const entrants = Array.from({ length: 17 }, (_, i) => entrant(i + 1, `seed-${i + 1}`));

    expect(() => generator.generate(entrants, 16)).toThrow();
  });
});
