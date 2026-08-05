import { describe, expect, it } from 'vitest';
import { RandomSource } from '../match-simulation/MatchSimulator';
import { PlayerRarityTier, StandardPlayerGenerationPolicy } from './PlayerGenerationPolicy';

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
    const values = [0.5, ...Array(9).fill(0), ...Array(4).fill(0), 0, 0, 0];
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
