import { describe, expect, it } from 'vitest';
import { RandomSource } from '../match-simulation/MatchSimulator';
import { AgeRange, PlayerRarityTier, POTENTIAL_TIER_ORDER, PotentialTier, StandardPlayerGenerationPolicy, tierForPotentialCeiling } from './PlayerGenerationPolicy';

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

/** A zero-width range: generate() still consumes a roll for age (so
 * every other roll's position in the sequence stays where the rest of
 * this file's scripted arrays expect it), but the result is pinned to
 * a single fixed age regardless of that roll's value — exactly what
 * every test below except the "age range"/"age-scaled noise" ones
 * needs, since they're not testing age at all. */
function fixedAge(weeks: number): AgeRange {
  return { minWeeks: weeks, maxWeeks: weeks };
}

/** Real games-of-record age window this policy is actually called
 * with today (see talentPoolAgeRange.ts) — used by tests below that
 * DO care about a real spread, not a pinned value. */
const REAL_AGE_RANGE: AgeRange = { minWeeks: 14 * 52, maxWeeks: 16 * 52 - 1 };

describe('StandardPlayerGenerationPolicy', () => {
  it('rolls the rarity tier from the second random value (the first is age), using strict thresholds at the tier boundaries', () => {
    const policy = new StandardPlayerGenerationPolicy();
    const age = fixedAge(800);

    // Roll 1 (age) is irrelevant at a fixed age. Roll 2: just under the
    // exceptional cutoff (0.03) -> exceptional.
    expect(policy.generate(new ScriptedRandomSource([0, 0.0299]), age).tier).toBe('exceptional');
    // Exactly at the exceptional cutoff -> falls through to strong.
    expect(policy.generate(new ScriptedRandomSource([0, 0.03]), age).tier).toBe('strong');
    // Just under the strong cutoff (0.03 + 0.17 = 0.20) -> strong.
    expect(policy.generate(new ScriptedRandomSource([0, 0.1999]), age).tier).toBe('strong');
    // Exactly at the strong cutoff -> falls through to common.
    expect(policy.generate(new ScriptedRandomSource([0, 0.2]), age).tier).toBe('common');
    // Comfortably inside the common range.
    expect(policy.generate(new ScriptedRandomSource([0, 0.5]), age).tier).toBe('common');
  });

  it('produces every skill within the rolled tier band, and picks name/nationality from the reference pools', () => {
    const policy = new StandardPlayerGenerationPolicy();
    // roll 1 -> age (irrelevant, fixed range). roll 2 (0.5) -> common
    // tier. Rolls 3-11 (0.0, 1 each) drive the nine skills to the exact
    // bottom of the common band (20). Rolls 12-15 drive the four
    // surface affinities to the bottom of their range (12). Rolls
    // 16-17 pick name indices, roll 18 nationality. Rolls 19-20 (0)
    // drive potentialCeiling to the tier band's own max (common: 42)
    // and potentialTier's noise roll to "one tier down".
    const values = [0, 0.5, ...Array(9).fill(0), ...Array(4).fill(0), 0, 0, 0, 0, 0];
    const generated = policy.generate(new ScriptedRandomSource(values), fixedAge(800));

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

  describe('age', () => {
    it('rolls ageInWeeks uniformly within the given AgeRange, inclusive of both ends', () => {
      const policy = new StandardPlayerGenerationPolicy();
      const range: AgeRange = { minWeeks: 728, maxWeeks: 831 };

      expect(policy.generate(new ScriptedRandomSource([0]), range).ageInWeeks).toBe(728);
      expect(policy.generate(new ScriptedRandomSource([0.999999]), range).ageInWeeks).toBe(831);
      expect(policy.generate(new ScriptedRandomSource([0.5]), range).ageInWeeks).toBe(Math.round(728 + 0.5 * (831 - 728)));
    });

    it('pins ageInWeeks to a single value when the AgeRange has zero width, regardless of the roll', () => {
      const policy = new StandardPlayerGenerationPolicy();
      const range = fixedAge(750);

      expect(policy.generate(new ScriptedRandomSource([0]), range).ageInWeeks).toBe(750);
      expect(policy.generate(new ScriptedRandomSource([0.5]), range).ageInWeeks).toBe(750);
      expect(policy.generate(new ScriptedRandomSource([0.999999]), range).ageInWeeks).toBe(750);
    });

    it('over 1000 generations against the real 14-16yo talent-pool range, every rolled age falls inside the U16 junior band, never senior', () => {
      const policy = new StandardPlayerGenerationPolicy();
      const random = new SeededRandomSource(11);

      for (let i = 0; i < 1000; i++) {
        const generated = policy.generate(random, REAL_AGE_RANGE);
        expect(generated.ageInWeeks).toBeGreaterThanOrEqual(REAL_AGE_RANGE.minWeeks);
        expect(generated.ageInWeeks).toBeLessThanOrEqual(REAL_AGE_RANGE.maxWeeks);
        // 14*52 = 728 is the exact U14/U16 boundary this policy's
        // real-world range starts at, so every freshly-generated player
        // lands in the U16 band, never U14 — a real, worth-knowing
        // consequence of choosing this exact range, not a bug.
        expect(generated.ageInWeeks).toBeGreaterThanOrEqual(14 * 52);
        expect(generated.ageInWeeks).toBeLessThan(16 * 52);
      }
    });
  });

  // generate() consumes exactly 1 (age) + 1 (tier) + 9 (skills) + 4
  // (affinities) + 2 (name) + 1 (nationality) = 18 rolls before
  // reaching the ceiling/noise rolls. The VALUES of rolls 2-18 are
  // irrelevant to potentialCeiling/potentialTier — the ceiling formula
  // reads the tier's fixed band.max constant, never the actual
  // realized skill/affinity/name/nationality rolls — so they're just
  // padded with 0 here for a clean, obviously-correct roll count
  // instead of hand-counting array lengths per test. Age is pinned via
  // fixedAge() in every one of these, so the age roll's value (0) is
  // never actually exercised for its age-scaling effect on noise.
  const PRE_HEADROOM_COMMON = [0, 0.5, ...Array(16).fill(0)]; // roll 1 age (pinned), roll 2 (0.5) -> common tier (band max 42)
  const PRE_HEADROOM_EXCEPTIONAL = [0, 0, ...Array(16).fill(0)]; // roll 1 age (pinned), roll 2 (0) -> exceptional tier (band max 94)
  const MID_AGE = fixedAge(800); // arbitrary fixed age -> FIXED_AGE_NOISE_PROBABILITY (0.15), same as this policy's old flat noise

  describe('potentialCeiling / potentialTier', () => {
    it('anchors the ceiling to the tier band max plus a headroom roll, never below the band max', () => {
      const policy = new StandardPlayerGenerationPolicy();
      const zeroHeadroom = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0]), MID_AGE);
      expect(zeroHeadroom.potentialCeiling).toBe(42); // common band max + 0 headroom

      const maxHeadroom = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0.999999]), MID_AGE);
      expect(maxHeadroom.potentialCeiling).toBe(87); // 42 + round(0.999999 * 45) = 42 + 45
    });

    it('clamps the ceiling at 99 even with a high tier band plus max headroom', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // Exceptional band max (94) + max headroom (45) = 139 uncapped.
      const generated = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_EXCEPTIONAL, 0.999999]), MID_AGE);
      expect(generated.tier).toBe('exceptional');
      expect(generated.potentialCeiling).toBe(99);
    });

    it('at a fixed (zero-width) age, the noise roll behaves exactly as the old flat model: <0.15 undershoots, <0.30 overshoots, otherwise true tier', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // Zero headroom -> true ceiling 42 -> tierForPotentialCeiling(42) = 'limited'.
      expect(tierForPotentialCeiling(42)).toBe('limited');

      // Noise roll 0.1 (< 0.15) -> would undershoot, but 'limited' is
      // already the bottom of POTENTIAL_TIER_ORDER, so it clamps there.
      expect(policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0, 0.1]), MID_AGE).potentialTier).toBe('limited');
      // Noise roll 0.2 (in [0.15, 0.30)) -> overshoots by one: 'promising'.
      expect(policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0, 0.2]), MID_AGE).potentialTier).toBe('promising');
      // Noise roll 0.5 (>= 0.30) -> exact true tier: 'limited'.
      expect(policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_COMMON, 0, 0.5]), MID_AGE).potentialTier).toBe('limited');
    });

    it('clamps the overshoot at the top of POTENTIAL_TIER_ORDER for an already-elite true tier', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // Exceptional tier, max headroom -> ceiling 99 -> true tier 'elite' already.
      const generated = policy.generate(new ScriptedRandomSource([...PRE_HEADROOM_EXCEPTIONAL, 0.999999, 0.2]), MID_AGE); // 0.2 would overshoot
      expect(tierForPotentialCeiling(generated.potentialCeiling)).toBe('elite');
      expect(generated.potentialTier).toBe('elite'); // clamped, not out of range
    });

    it('age-scales the noise probability: the youngest age in a range is noisier (~40% off-by-one) than the oldest (~20% off-by-one)', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // A real (non-zero-width) range, so noiseProbabilityForAge computes
      // a genuine interpolated value — pinning via fixedAge() (zero
      // width) would collapse straight to FIXED_AGE_NOISE_PROBABILITY
      // regardless of which "end" it's meant to represent, which is
      // NOT what this test is checking.
      const range: AgeRange = { minWeeks: 728, maxWeeks: 831 };
      const restOfRolls = [0.5, ...Array(16).fill(0)]; // tier(common) + skills + affinities + name + nationality

      // Fixed 'limited' true tier (zero headroom, common band) so every
      // off-target result is unambiguously "one tier up" (0.2 overshoots
      // at the youngest noise probability but 0.2 is BELOW the oldest
      // noise probability's overshoot band too — pick roll values that
      // land differently at each end instead of reusing one value).
      const noiseRoll = 0.15; // < 0.2 (youngest undershoot band) but >= 0.1 and < 0.2 (oldest overshoot band)

      // Age roll 0 -> exactly minWeeks (youngest); age roll ~1 -> exactly maxWeeks (oldest).
      const atYoungest = policy.generate(new ScriptedRandomSource([0, ...restOfRolls, 0, noiseRoll]), range);
      const atOldest = policy.generate(new ScriptedRandomSource([0.999999, ...restOfRolls, 0, noiseRoll]), range);

      // Youngest: noiseProbability=0.2, roll 0.15 < 0.2 -> undershoots,
      // clamped at the bottom ('limited' stays 'limited').
      expect(atYoungest.potentialTier).toBe('limited');
      // Oldest: noiseProbability=0.1, roll 0.15 is in [0.1, 0.2) ->
      // overshoots by one -> 'promising'.
      expect(atOldest.potentialTier).toBe('promising');
    });

    it('over 1000 generations at the real range, the youngest-band candidates show a true tier noticeably less often than the oldest-band candidates', () => {
      const policy = new StandardPlayerGenerationPolicy();
      // Pins ONLY the age roll (generate()'s first roll) to a fixed
      // value on demand, while every other roll (tier, skills, ceiling,
      // noise) keeps drawing from a real seeded PRNG — so this isolates
      // age's effect on noise from a genuinely varying sample, without
      // collapsing the range to zero width the way fixedAge() would
      // (which would defeat noiseProbabilityForAge's interpolation
      // entirely — see the test above this one).
      class AgePinningRandomSource implements RandomSource {
        private pinNext = false;
        constructor(
          private readonly pinnedAgeRoll: number,
          private readonly inner: RandomSource,
        ) {}
        armAgeRoll(): void {
          this.pinNext = true;
        }
        next(): number {
          if (this.pinNext) {
            this.pinNext = false;
            return this.pinnedAgeRoll;
          }
          return this.inner.next();
        }
      }

      const range = REAL_AGE_RANGE;
      const shared = new SeededRandomSource(23);
      const youngRandom = new AgePinningRandomSource(0, shared); // age roll 0 -> exactly minWeeks
      const oldRandom = new AgePinningRandomSource(0.999999, shared); // age roll ~1 -> exactly maxWeeks

      let exactAtYoungest = 0;
      let exactAtOldest = 0;
      for (let i = 0; i < 1000; i++) {
        youngRandom.armAgeRoll();
        const y = policy.generate(youngRandom, range);
        const yTrue = tierForPotentialCeiling(y.potentialCeiling);
        if (y.potentialTier === yTrue) exactAtYoungest += 1;

        oldRandom.armAgeRoll();
        const o = policy.generate(oldRandom, range);
        const oTrue = tierForPotentialCeiling(o.potentialCeiling);
        if (o.potentialTier === oTrue) exactAtOldest += 1;
      }

      // Expected ~60% exact at the youngest end, ~80% at the oldest —
      // but true tiers landing at either end of POTENTIAL_TIER_ORDER
      // clamp instead of going off-range, which pushes the real exact
      // rate above the naive 1-2*noiseProbability formula (the original
      // flat-noise test below has the exact same widening, 550-850
      // around a 700 nominal). Bounds here are loose for the same
      // non-flaky reason, but still tight enough to catch age-scaling
      // being absent entirely (which would put both groups around 700
      // with no separation between them).
      expect(exactAtYoungest).toBeLessThan(750);
      expect(exactAtOldest).toBeGreaterThan(750);
      expect(exactAtOldest - exactAtYoungest).toBeGreaterThan(50);
    });

    it('over 1000 generations, the noisy potentialTier matches the true tier roughly 70% of the time at a fixed (zero-width) age, off-by-one the rest, and never off by more than one step', () => {
      const policy = new StandardPlayerGenerationPolicy();
      const random = new SeededRandomSource(7);
      let exact = 0;
      let offByOne = 0;

      for (let i = 0; i < 1000; i++) {
        const generated = policy.generate(random, MID_AGE);
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
      const generated = policy.generate(random, REAL_AGE_RANGE);
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
