import { describe, expect, it } from 'vitest';
import { PlayerId } from '../shared/ids';
import { selectWildCards, wildCardSlotsFor, WildCardCandidate } from './WildCardPolicy';

describe('wildCardSlotsFor', () => {
  it('awards wild card slots at every senior tier that holds qualifying', () => {
    expect(wildCardSlotsFor('major')).toBeGreaterThan(0);
    expect(wildCardSlotsFor('tour')).toBeGreaterThan(0);
    expect(wildCardSlotsFor('challenger')).toBeGreaterThan(0);
  });

  it('awards none at futures — a wild card only means something as an alternative to qualifying, and futures holds none', () => {
    expect(wildCardSlotsFor('futures')).toBe(0);
  });

  it('awards none at any junior tier', () => {
    for (const tier of ['j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'] as const) {
      expect(wildCardSlotsFor(tier)).toBe(0);
    }
  });
});

describe('selectWildCards', () => {
  const p1: WildCardCandidate = { playerId: PlayerId('p1'), nationality: 'Brazil', rank: 220 };
  const p2: WildCardCandidate = { playerId: PlayerId('p2'), nationality: 'Brazil', rank: 180 };
  const p3: WildCardCandidate = { playerId: PlayerId('p3'), nationality: 'France', rank: 150 };

  it('selects only candidates sharing the host country, best-ranked first', () => {
    const selected = selectWildCards([p1, p2, p3], 'Brazil', 2);
    expect(selected).toEqual([PlayerId('p2'), PlayerId('p1')]);
  });

  it('never selects more than the available slot count', () => {
    const selected = selectWildCards([p1, p2], 'Brazil', 1);
    expect(selected).toEqual([PlayerId('p2')]);
  });

  it('returns nothing when the tournament has no recorded host country', () => {
    expect(selectWildCards([p1, p2], null, 2)).toEqual([]);
  });

  it('returns nothing when no candidate shares the host country', () => {
    expect(selectWildCards([p3], 'Brazil', 2)).toEqual([]);
  });

  it('returns nothing when there are zero slots', () => {
    expect(selectWildCards([p1, p2], 'Brazil', 0)).toEqual([]);
  });

  it('prefers a ranked candidate over an unranked one, and breaks an unranked tie by playerId', () => {
    const ranked: WildCardCandidate = { playerId: PlayerId('pZ'), nationality: 'Spain', rank: 300 };
    const unrankedA: WildCardCandidate = { playerId: PlayerId('pB'), nationality: 'Spain', rank: null };
    const unrankedB: WildCardCandidate = { playerId: PlayerId('pA'), nationality: 'Spain', rank: null };
    const selected = selectWildCards([unrankedA, ranked, unrankedB], 'Spain', 3);
    expect(selected).toEqual([PlayerId('pZ'), PlayerId('pA'), PlayerId('pB')]);
  });
});
