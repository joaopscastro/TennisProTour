import { describe, expect, it } from 'vitest';
import { DIRECT_ACCEPTANCE_CUTOFF } from './ObligatoryTournamentPolicy';
import { hasQualifying, qualifierSlotsFor, resolveEntryType } from './QualifyingPolicy';

describe('QualifyingPolicy — which tiers hold qualifying', () => {
  it('holds qualifying at the two biggest senior tiers and nowhere else', () => {
    expect(hasQualifying('major')).toBe(true);
    expect(hasQualifying('tour')).toBe(true);
    expect(hasQualifying('challenger')).toBe(false);
    expect(hasQualifying('futures')).toBe(false);
  });

  it('never holds qualifying at any junior tier', () => {
    for (const tier of ['j30', 'j60', 'j100', 'j200', 'j300', 'j500', 'juniorMasters'] as const) {
      expect(hasQualifying(tier)).toBe(false);
      expect(qualifierSlotsFor(tier, 32)).toBe(0);
    }
  });

  it('reserves an eighth of the main draw, mirroring the real 16-of-128 at a Slam', () => {
    expect(qualifierSlotsFor('major', 128)).toBe(16);
    expect(qualifierSlotsFor('tour', 32)).toBe(4);
    expect(qualifierSlotsFor('tour', 16)).toBe(2);
  });

  it('reserves nothing at a tier without qualifying, however large the draw', () => {
    expect(qualifierSlotsFor('challenger', 128)).toBe(0);
  });
});

describe('QualifyingPolicy — resolveEntryType', () => {
  it('accepts everyone as a direct acceptance at a tier without qualifying', () => {
    const decision = resolveEntryType({ tier: 'challenger', drawSize: 32, rank: null, qualifierSlotsTaken: 0 });
    expect(decision).toEqual({ kind: 'accepted', entryType: 'DA', qualifierSlots: 0 });
  });

  it('grants direct acceptance exactly at the cutoff, and qualifying one place below it', () => {
    const atCutoff = resolveEntryType({
      tier: 'major',
      drawSize: 128,
      rank: DIRECT_ACCEPTANCE_CUTOFF,
      qualifierSlotsTaken: 0,
    });
    expect(atCutoff.entryType).toBe('DA');

    const belowCutoff = resolveEntryType({
      tier: 'major',
      drawSize: 128,
      rank: DIRECT_ACCEPTANCE_CUTOFF + 1,
      qualifierSlotsTaken: 0,
    });
    expect(belowCutoff).toEqual({ kind: 'accepted', entryType: 'Q', qualifierSlots: 16 });
  });

  it('treats an unranked player as a qualifier, never a direct acceptance', () => {
    const decision = resolveEntryType({ tier: 'major', drawSize: 128, rank: null, qualifierSlotsTaken: 0 });
    expect(decision).toEqual({ kind: 'accepted', entryType: 'Q', qualifierSlots: 16 });
  });

  it('refuses a below-cutoff registrant once every reserved slot is taken', () => {
    const decision = resolveEntryType({ tier: 'tour', drawSize: 32, rank: 500, qualifierSlotsTaken: 4 });
    expect(decision.kind).toBe('qualifying-full');
    expect(decision.qualifierSlots).toBe(4);
  });

  it('never refuses an above-cutoff registrant just because qualifying is full', () => {
    const decision = resolveEntryType({ tier: 'tour', drawSize: 32, rank: 3, qualifierSlotsTaken: 4 });
    expect(decision).toEqual({ kind: 'accepted', entryType: 'DA', qualifierSlots: 4 });
  });
});
