import { describe, expect, it } from 'vitest';
import { DIRECT_ACCEPTANCE_CUTOFF } from './ObligatoryTournamentPolicy';
import {
  hasQualifying,
  qualifierSlotsFor,
  qualifyingDrawSizeFor,
  qualifyingPlayersPerSlot,
  qualifyingPointsFor,
  qualifyingRoundCountFor,
  resolveEntryType,
} from './QualifyingPolicy';

describe('QualifyingPolicy — which tiers hold qualifying', () => {
  it('holds qualifying at the three upper senior tiers, but never at the freely-enterable bottom rung', () => {
    expect(hasQualifying('major')).toBe(true);
    expect(hasQualifying('tour')).toBe(true);
    expect(hasQualifying('challenger')).toBe(true);
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
    expect(qualifierSlotsFor('futures', 128)).toBe(0);
  });
});

describe('QualifyingPolicy — the qualifying field itself (full model)', () => {
  it("sizes a major's qualifying like the real thing: 128 players for 16 places, 3 rounds", () => {
    expect(qualifierSlotsFor('major', 128)).toBe(16);
    expect(qualifyingDrawSizeFor('major', 128)).toBe(128);
    expect(qualifyingRoundCountFor('major', 128)).toBe(3);
  });

  it('runs a shorter two-round qualifying at the tiers below a major', () => {
    expect(qualifyingDrawSizeFor('tour', 32)).toBe(16);
    expect(qualifyingRoundCountFor('tour', 32)).toBe(2);
    expect(qualifyingDrawSizeFor('challenger', 32)).toBe(16);
    expect(qualifyingRoundCountFor('challenger', 32)).toBe(2);
  });

  it('has no qualifying field at all at a tier that holds none', () => {
    expect(qualifyingPlayersPerSlot('futures')).toBe(0);
    expect(qualifyingDrawSizeFor('futures', 32)).toBe(0);
    expect(qualifyingRoundCountFor('futures', 32)).toBe(0);
    expect(qualifyingRoundCountFor('j100', 32)).toBe(0);
  });

  it('never runs a one-round qualifying draw — a structural requirement, not a balance choice', () => {
    // A single round could produce winners who advanced on a bye and so
    // have no match at all; Tournament.qualifyingWinners() deliberately
    // reads outcomes only. See QUALIFYING_PLAYERS_PER_SLOT's doc comment.
    for (const tier of ['major', 'tour', 'challenger'] as const) {
      for (const drawSize of [16, 32, 64, 128] as const) {
        if (qualifierSlotsFor(tier, drawSize) === 0) continue;
        expect(qualifyingPlayersPerSlot(tier)).toBeGreaterThanOrEqual(4);
        expect(qualifyingRoundCountFor(tier, drawSize)).toBeGreaterThanOrEqual(2);
        expect(Number.isInteger(qualifyingRoundCountFor(tier, drawSize))).toBe(true);
      }
    }
  });

  it('pays nothing for losing a first qualifying match, and a little for winning one', () => {
    expect(qualifyingPointsFor('major', 0)).toBe(0);
    expect(qualifyingPointsFor('major', 1)).toBeGreaterThan(0);
    expect(qualifyingPointsFor('major', 2)).toBeGreaterThan(qualifyingPointsFor('major', 1));
    expect(qualifyingPointsFor('futures', 1)).toBe(0);
    expect(qualifyingPointsFor('j100', 1)).toBe(0);
  });

  it('never pays a qualifying result anywhere near a main-draw result at the same tier', () => {
    // Coming through qualifying is worth a main-draw place, not points.
    // Real, sourced values (2026 PIF ATP Rankings, 9.02.G.4): the
    // smallest real main-draw win at both major and tour is 50 points
    // (a first-round win at a Grand Slam or this project's ATP-1000-
    // mapped `tour` tier — see StandardRankingPointsTable's doc
    // comment); the real qualifying-elimination ceiling (16, a last-
    // qualifying-round loss) sits comfortably under it at both.
    expect(qualifyingPointsFor('major', 2)).toBeLessThan(50);
    expect(qualifyingPointsFor('tour', 2)).toBeLessThan(50);
  });
});

describe('QualifyingPolicy — resolveEntryType', () => {
  it('accepts everyone as a direct acceptance at a tier without qualifying', () => {
    const decision = resolveEntryType({ tier: 'futures', drawSize: 32, rank: null, qualifierSlotsTaken: 0 });
    expect(decision).toEqual({ kind: 'accepted', entryType: 'DA', qualifierSlots: 0 });
  });

  it('refuses a below-cutoff registrant only once the whole qualifying FIELD is full, not merely its slots', () => {
    // The full model's key difference from the light one: several players
    // compete for each reserved slot, so the field holds many more `[Q]`
    // registrants than there are places at stake.
    const stillRoom = resolveEntryType({
      tier: 'tour',
      drawSize: 32,
      rank: 500,
      qualifierSlotsTaken: 4,
      qualifierSlots: 4,
      qualifyingCapacity: 16,
    });
    expect(stillRoom).toEqual({ kind: 'accepted', entryType: 'Q', qualifierSlots: 4 });

    const fieldFull = resolveEntryType({
      tier: 'tour',
      drawSize: 32,
      rank: 500,
      qualifierSlotsTaken: 16,
      qualifierSlots: 4,
      qualifyingCapacity: 16,
    });
    expect(fieldFull.kind).toBe('qualifying-full');
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

  it('falls back to the reserved-slot count as capacity when none is supplied', () => {
    const decision = resolveEntryType({ tier: 'tour', drawSize: 32, rank: 500, qualifierSlotsTaken: 4 });
    expect(decision.kind).toBe('qualifying-full');
    expect(decision.qualifierSlots).toBe(4);
  });

  it('never refuses an above-cutoff registrant just because qualifying is full', () => {
    const decision = resolveEntryType({ tier: 'tour', drawSize: 32, rank: 3, qualifierSlotsTaken: 4 });
    expect(decision).toEqual({ kind: 'accepted', entryType: 'DA', qualifierSlots: 4 });
  });
});
