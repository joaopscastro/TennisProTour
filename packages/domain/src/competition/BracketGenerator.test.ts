import { describe, expect, it } from 'vitest';
import { asPlayerId } from '../shared/ids';
import { TournamentEntrant } from './CompetitionTypes';
import { BracketGenerator } from './BracketGenerator';

function entrant(seed: number, id: string): TournamentEntrant {
  return { playerId: asPlayerId(id), seed };
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
      [asPlayerId('seed-1'), asPlayerId('seed-16')],
      [asPlayerId('seed-8'), asPlayerId('seed-9')],
      [asPlayerId('seed-4'), asPlayerId('seed-13')],
      [asPlayerId('seed-5'), asPlayerId('seed-12')],
      [asPlayerId('seed-2'), asPlayerId('seed-15')],
      [asPlayerId('seed-7'), asPlayerId('seed-10')],
      [asPlayerId('seed-3'), asPlayerId('seed-14')],
      [asPlayerId('seed-6'), asPlayerId('seed-11')],
    ]);
    expect(round1.matches.every((m) => m.outcome === null)).toBe(true);
  });

  it('gives byes to the top seeds when entrants fall short of the draw size', () => {
    const entrants = Array.from({ length: 10 }, (_, i) => entrant(i + 1, `seed-${i + 1}`));

    const [round1] = generator.generate(entrants, 16);

    // 6 byes (16 - 10) go to the top 6 seeds; only seeds 7-10 play round 1.
    expect(round1.matches).toHaveLength(2);
    expect(round1.matches.map((m) => [m.entrantA, m.entrantB])).toEqual([
      [asPlayerId('seed-8'), asPlayerId('seed-9')],
      [asPlayerId('seed-7'), asPlayerId('seed-10')],
    ]);

    const playingIds = new Set(round1.matches.flatMap((m) => [m.entrantA, m.entrantB]));
    for (let seed = 1; seed <= 6; seed++) {
      expect(playingIds.has(asPlayerId(`seed-${seed}`))).toBe(false);
    }
  });

  it('throws when there are more entrants than the draw size', () => {
    const entrants = Array.from({ length: 17 }, (_, i) => entrant(i + 1, `seed-${i + 1}`));

    expect(() => generator.generate(entrants, 16)).toThrow();
  });
});
