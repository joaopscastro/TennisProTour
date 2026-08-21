import { describe, expect, it } from 'vitest';
import { wildCardSlotsFor } from './WildCardPolicy';

describe('wildCardSlotsFor', () => {
  it('awards wild card slots at every senior tier', () => {
    expect(wildCardSlotsFor('major')).toBeGreaterThan(0);
    expect(wildCardSlotsFor('tour')).toBeGreaterThan(0);
    expect(wildCardSlotsFor('challenger')).toBeGreaterThan(0);
    expect(wildCardSlotsFor('futures')).toBeGreaterThan(0);
  });

  it('awards none at any junior tier', () => {
    for (const tier of ['j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'] as const) {
      expect(wildCardSlotsFor(tier)).toBe(0);
    }
  });
});
