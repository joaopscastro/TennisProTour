import { describe, expect, it } from 'vitest';
import { RandomSource } from '../match-simulation/MatchSimulator';
import { PlayerRarityTier, POTENTIAL_TIER_ORDER, PotentialTier, StandardPlayerGenerationPolicy, tierForPotentialCeiling } from './PlayerGenerationPolicy';

/** Replays a fixed sequence, cycling once exhausted — same pattern as
 * StatisticalMatchSimulator.test.ts's ScriptedRandomSource. */
class ScriptedRandomSource implements RandomSource {
  private index = 0;
  constructor(private readonly values: number[]) {}
  next(): number {
    const value = this.values[this.index % this.values.length];
    this.index += 1;
    return value;
  }
}

/**
 * A tiny deterministic PRNG (mulberry32), used only so the statistical
 * distribution test below is a real pseudo-random spread across 1000
 * generations — not a scripted exact sequence — while staying 100%
 * reproducible across CI runs (no reliance on Math.random(), which
 * would make a statistical assertion flaky).
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SeededRandomSource implements RandomSource {
  private readonly rand: () => number;
  constructor(seed: number) {
    this.rand = mulberry32(seed);
  }
  next(): number {
    return this.rand();
  }
}

const SKILL_BANDS: Record<PlayerRarityTier, { min: number; max: number }> = {
  common: { min: 20, max: 42 },
  strong: { min: 48, max: 68 },
  exceptional: { min: 74, max: 94 },
};

describe('StandardPlayerGenerationPolicy', () => {
  it('rolls the rarity tier from the first random value, using strict thresholds at the tier boundaries', () => {
    const policy = new StandardPlayerGenerationPolicy();

    // Just under the exceptional cutoff (0.03) -> exceptional.
    expect(policy.generate(new ScriptedRandomSource([0.0299])).tier).toBe('exceptional');
    // Exactly at the exceptional cutoff -> falls through to strong.
    expect(policy.generate(new ScriptedRandomSource([0.03])).tier).toBe('strong');
    // Just under the strong cutoff (0.03 + 0.17 = 0.20) -> strong.
    expect(policy.generate(new ScriptedRandomSource([0.1999])).tier).toBe('strong');
    // Exactly at the strong cutoff -> falls through to common.
    expect(policy.generate(new ScriptedRandomSource([0.2])).tier).toBe('common');
    // Comfortably inside the common range.
    expect(policy.generate(new ScriptedRandomSource([0.5])).tier).toBe('common');
  });

  it('produces every skill within the rolled tier band, and picks name/nationality from the reference pools', () => {
    const policy = new StandardPlayerGenerationPolicy();
    // roll 1 (0.5) -> common tier. Rolls 2-10 (0.0, 1 each) drive the
    // nine skills to the exact bottom of the common band (20). Rolls
    // 11-14 drive the four surface affinities to the bottom of their
    // range (12). Rolls 15-16 pick name indices, roll 17 nationality.
    // Rolls 18-19 (0) drive potentialCeiling to the tier band's own max
    // (common: 42) and potentialTier's noise roll to "one tier down".
    const values = [0.5, ...Array(9).fill(0), ...Array(4).fill(0), 0, 0, 0, 0, 0];
    const generated = policy.generate(new ScriptedRandomSource(values));

    expect(generated.tier).toBe('common');
    expect(generated.attributes.technical.serve.value).toBe(20);
    expect(generated.attributes.technical.forehand.value).toBe(20);
    expect(generated.attributes.physical.speed.value).toBe(20);
    expect(generated.attributes.mental.clutch.value).toBe(20);
    expect(generated.attributes.surfaceAffinities.get('clay')).toBe(12);
    expect(generated.attributes.surfaceAffinities.get('indoor')).toBe(12);
    expect(generated.name.split(' ')).toHaveLength(2);
    expect(generated.name).toMatch(/^[A-Z][a-z]+ [A-Z]/); // "Firstname Lastname"
    expect(generated.nationality).toMatch(/^[A-Z]{2}$/);
    // Zero headroom -> ceiling lands exactly on the common band's max (42).
    expect(generated.potentialCeiling).toBe(42);
  });

  // generate() consumes exactly 17 rolls before reaching the
  // ceiling/noise rolls: 1 (tier) + 9 (skills) + 4 (affinities) + 2
  // (name) + 1 (nationality). The VALUES of the 16 rolls after the
  // tier roll are irrelevant to potentialCeiling/potentialTier — the
  // ceiling formula reads the tier's fixed band.max constant, never
  // the actual realized skill/affinity/name/nationality rolls — so
  // they're just padded with 0 here for a clean, obviously-correct
  // roll count instead of hand-counting array lengths per test.
  const PRE_HEADROOM_COMMON = [0.5, ...Array(16).fill(0)]; // roll 1 (0.5) -> common tier (band max 42)
  const PRE_HEADROOM_EXCEPTIONAL = [0, ...Array(16).fill(0)]; // roll 1 (0) -> exceptional tier (band max 94)

  describe('potentialCeiling / potentialTier', () => {
    it('anchors the ceiling to the tier band max plus a headroom roll, never below the band max', () => {
      const policy = new StandardPlayerGenerationPolicy();
      const zeroHeadroom = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0]));
      expect(zeroHeadroom.potentialCeiling).toBe(42); // common band max + 0 headroom

      const maxHeadroom = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0.999999]));
      expect(maxHeadroom.potentialCeiling).toBe(87); // 42 + round(0.999999 * 45) = 42 + 45
    });

    it('clamps the ceiling at 99 even with a high tier band plus max headroom', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // Exceptional band max (94) + max headroom (45) = 139 uncapped.
      const generated = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_EXCEPTIONAL, 0.999999]));
      expect(generated.tier).toBe('exceptional');
      expect(generated.potentialCeiling).toBe(99);
    });

    it('the noise roll: <0.15 undershoots by one tier, <0.30 overshoots by one tier, otherwise the true tier', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // Zero headroom -> true ceiling 42 -> tierForPotentialCeiling(42) = 'limited'.
      expect(tierForPotentialCeiling(42)).toBe('limited');

      // Noise roll 0.1 (< 0.15) -> would undershoot, but 'limited' is
      // already the bottom of POTENTIAL_TIER_ORDER, so it clamps there.
      expect(policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0, 0.1])).potentialTier).toBe('limited');
      // Noise roll 0.2 (in [0.15, 0.30)) -> overshoots by one: 'promising'.
      expect(policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0, 0.2])).potentialTier).toBe('promising');
      // Noise roll 0.5 (>= 0.30) -> exact true tier: 'limited'.
      expect(policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0, 0.5])).potentialTier).toBe('limited');
    });

    it('clamps the overshoot at the top of POTENTIAL_TIER_ORDER for an already-elite true tier', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // Exceptional tier, max headroom -> ceiling 99 -> true tier 'elite' already.
      const generated = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_EXCEPTIONAL, 0.999999, 0.2])); // 0.2 would overshoot
      expect(tierForPotentialCeiling(generated.potentialCeiling)).toBe('elite');
      expect(generated.potentialTier).toBe('elite'); // clamped, not out of range
    });

    it('over 1000 generations, the noisy potentialTier matches the true tier roughly 70% of the time, off-by-one the rest, and never off by more than one step', () => {
      const policy = new StandardPlayerGenerationPolicy();
      const random = new SeededRandomSource(7);
      let exact = 0;
      let offByOne = 0;

      for (let i = 0; i < 1000; i++) {
        const generated = policy.generate(random);
        const trueTier = tierForPotentialCeiling(generated.potentialCeiling);
        const trueIndex = POTENTIAL_TIER_ORDER.indexOf(trueTier);
        const shownIndex = POTENTIAL_TIER_ORDER.indexOf(generated.potentialTier);
        const distance = Math.abs(trueIndex - shownIndex);

        expect(distance).toBeLessThanOrEqual(1); // never wildly wrong
        if (distance === 0) exact += 1;
        else offByOne += 1;
      }

      expect(exact + offByOne).toBe(1000);
      // ~70% exact expected; loose bounds for the same non-flaky reasons
      // as the rarity-tier distribution test above.
      expect(exact).toBeGreaterThan(550);
      expect(exact).toBeLessThan(850);
    });
  });

  it('over 1000 generations, the rarity tiers occur within their expected rough percentages, and every generated overall rating lands inside its tier band', () => {
    const policy = new StandardPlayerGenerationPolicy();
    const random = new SeededRandomSource(42);
    const counts: Record<PlayerRarityTier, number> = { common: 0, strong: 0, exceptional: 0 };

    for (let i = 0; i < 1000; i++) {
      const generated = policy.generate(random);
      counts[generated.tier] += 1;

      // Every skill (and therefore the average overallRating) can
      // only ever fall within its rolled tier's band, by construction —
      // asserted per-generation, not just on the aggregate counts.
      const band = SKILL_BANDS[generated.tier];
      const overall = generated.attributes.overallRating();
      expect(overall).toBeGreaterThanOrEqual(band.min);
      expect(overall).toBeLessThanOrEqual(band.max);
    }

    expect(counts.common + counts.strong + counts.exceptional).toBe(1000);

    // Expected ~30/1000 (3%) exceptional, ~170/1000 (17%) strong,
    // ~800/1000 (80%) common. Bounds are deliberately loose (well
    // outside a few standard deviations of the binomial spread) so
    // this never flakes, while still being tight enough to catch a
    // genuinely wrong distribution (e.g. tiers swapped, or a
    // near-50/50 split).
    expect(counts.exceptional).toBeGreaterThan(5);
    expect(counts.exceptional).toBeLessThan(60);
    expect(counts.strong).toBeGreaterThan(100);
    expect(counts.strong).toBeLessThan(250);
    expect(counts.common).toBeGreaterThan(700); // clearly the dominant tier
  });
});
