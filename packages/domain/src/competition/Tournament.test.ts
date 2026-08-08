import { describe, expect, it } from 'vitest';
import { PlayerId, TournamentId } from '../shared/ids';
import { BracketGenerator } from './BracketGenerator';
import { Tournament, TournamentOpenProps } from './Tournament';

function baseProps(overrides: Partial<TournamentOpenProps> = {}): TournamentOpenProps {
  return {
    id: TournamentId('t1'),
    tier: 'challenger',
    surface: 'hard',
    weekScheduled: { season: 1, week: 1 },
    drawSize: 16,
    ...overrides,
  };
}

describe('Tournament.open — ageBand invariant', () => {
  it('defaults ageBand to null for a senior tier and accepts it', () => {
    const tournament = Tournament.open(baseProps({ tier: 'tour' }));
    expect(tournament.ageBand).toBeNull();
  });

  it('rejects a senior tier that is given an ageBand', () => {
    expect(() => Tournament.open(baseProps({ tier: 'major', ageBand: 'u16' }))).toThrow(/must not have an ageBand/);
  });

  it('accepts a junior tier paired with an ageBand, and stores it', () => {
    const u14 = Tournament.open(baseProps({ tier: 'j100', ageBand: 'u14' }));
    expect(u14.ageBand).toBe('u14');

    const u16 = Tournament.open(baseProps({ tier: 'j100', ageBand: 'u16' }));
    expect(u16.ageBand).toBe('u16');
  });

  it('rejects a junior tier with no ageBand', () => {
    expect(() => Tournament.open(baseProps({ tier: 'j30' }))).toThrow(/requires an ageBand/);
  });

  it('applies the same six J-grades identically to both age bands — the tier alone does not encode age', () => {
    const u14 = Tournament.open(baseProps({ tier: 'j500', ageBand: 'u14' }));
    const u16 = Tournament.open(baseProps({ tier: 'j500', ageBand: 'u16' }));
    expect(u14.tier).toBe(u16.tier);
    expect(u14.ageBand).not.toBe(u16.ageBand);
  });
});

describe('Tournament.startWithBracket — refuses a field too sparse to produce a single real match', () => {
  const generator = new BracketGenerator();

  it('refuses a 16-draw with 8 unseeded entrants — every one lands on the bye side of its pair, zero real matches', () => {
    const tournament = Tournament.open(baseProps());
    for (let i = 1; i <= 8; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: null });
    }
    const bracket = generator.generate(tournament.entrants, 16);
    expect(bracket[0].matches).toHaveLength(0); // confirms the premise, not just the guard

    expect(() => tournament.startWithBracket(bracket)).toThrow(/too sparse a field/);
    expect(tournament.hasStarted).toBe(false); // the throw must not leave it half-started
  });

  it('accepts a 16-draw with 9 unseeded entrants — the threshold where BracketGenerator first produces a real match', () => {
    const tournament = Tournament.open(baseProps());
    for (let i = 1; i <= 9; i++) {
      tournament.registerEntrant({ playerId: PlayerId(`p${i}`), seed: null });
    }
    const bracket = generator.generate(tournament.entrants, 16);
    expect(bracket[0].matches.length).toBeGreaterThan(0);

    expect(() => tournament.startWithBracket(bracket)).not.toThrow();
    expect(tournament.hasStarted).toBe(true);
  });

  it('still refuses a literally empty bracket (no rounds at all), same as before this guard existed', () => {
    const tournament = Tournament.open(baseProps());
    tournament.registerEntrant({ playerId: PlayerId('p1'), seed: null });

    expect(() => tournament.startWithBracket([])).toThrow(/empty bracket/);
  });
});
