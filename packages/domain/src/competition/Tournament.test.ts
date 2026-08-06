import { describe, expect, it } from 'vitest';
import { TournamentId } from '../shared/ids';
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
