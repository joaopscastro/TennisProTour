import { PlayerAttributes, Skill, SurfaceAffinities } from './PlayerAttributes';
import { RandomSource } from '../match-simulation/MatchSimulator';

/**
 * How rare a generated player's overall skill band is. Exposed (not
 * just an internal detail of the skill roll) because both the pool
 * browse screen and this policy's own tests need to know which band a
 * generation landed in without re-deriving it from raw skill numbers.
 */
export type PlayerRarityTier = 'common' | 'strong' | 'exceptional';

/**
 * A coarse, imperfect read on a player's hidden potentialCeiling —
 * what scouting actually exposes (see GeneratedPlayer.potentialTier's
 * doc comment for why this is deliberately fuzzy, not a precise
 * number). Ordered low-to-high; several places (the noise roll,
 * clamping at the ends) rely on this exact array order, not just the
 * type union.
 */
export type PotentialTier = 'limited' | 'promising' | 'high' | 'elite';
export const POTENTIAL_TIER_ORDER: readonly PotentialTier[] = ['limited', 'promising', 'high', 'elite'];

/**
 * The span of ages a single generate() call may produce, in weeks —
 * a caller-supplied input, never a constant baked into this policy
 * (see StandardPlayerGenerationPolicy's class doc comment for why: the
 * weekly talent-pool refresh and CreateCustomPlayerUseCase both
 * currently pass the same narrow youth-only range, but that's a
 * decision made at those call sites, not a constraint this generator
 * enforces or knows about — a future caller could pass a different
 * range without touching this file, same swappable-policy discipline
 * as AgingPolicy/TrainingPolicy).
 */
export interface AgeRange {
  minWeeks: number;
  maxWeeks: number;
}

/** t=0 at ageRange.minWeeks, t=1 at ageRange.maxWeeks — a plain linear
 * age-position factor. Originally inline inside
 * StandardPlayerGenerationPolicy.noiseProbabilityForAge (scouting's
 * potential-range uncertainty: younger prospects get noisier reads),
 * extracted here so any other age-blended formula reuses the exact
 * same interpolation shape instead of a second, possibly-drifted copy
 * — see StandardTalentClaimPricingPolicy.priceFor for the other real
 * caller (blended talent-claim pricing: near-flat at the youngest
 * generated age, progressively ability-dominated toward the oldest).
 * Falls back to 0.5 (the exact midpoint a zero-width range's old
 * flat-average behavior already gave) when there's no span to
 * interpolate across at all. Not clamped to [0,1] for an out-of-range
 * age — every real caller only ever passes an age that was itself
 * rolled from within this same range, so that case doesn't arise in
 * practice, and clamping would be defensive code for an input this
 * function doesn't control and no caller can actually produce. */
export function ageInterpolationFactor(ageInWeeks: number, ageRange: AgeRange): number {
  const span = ageRange.maxWeeks - ageRange.minWeeks;
  if (span <= 0) return 0.5;
  return (ageInWeeks - ageRange.minWeeks) / span;
}

/**
 * Hidden per-attribute training ceilings for the physical cluster
 * (speed/stamina/strength) — see docs/training-redesign-per-attribute.md.
 * Deliberately THREE independent numbers, not one shared ceiling
 * reused across all three: a player's speed and stamina ceilings can
 * (and generally do) land at different values, same as their current
 * speed and stamina values are independently rolled. Same non-exposure
 * discipline as the existing overall potentialCeiling — see
 * GeneratedPlayer.physicalCeilings' doc comment below.
 */
export interface PhysicalCeilings {
  speed: number;
  stamina: number;
  strength: number;
}

export interface GeneratedPlayer {
  name: string;
  nationality: string;
  tier: PlayerRarityTier;
  attributes: PlayerAttributes;
  /** Rolled uniformly within the AgeRange passed to generate() — see
   * that parameter's doc comment. Every generated player's starting
   * age now comes from here; there is no separate fixed "starting
   * age" constant anymore (StandardAgingPolicy is the only thing that
   * ever moves a player older, one week at a time). */
  ageInWeeks: number;
  /** The real, hidden ceiling each of this player's skills can
   * eventually reach through training (see
   * TrainingPolicy.applyPotentialDiminishingReturns) — generated once,
   * fixed for the player's whole career, and NEVER serialized in any
   * API response (see CreateCustomPlayerUseCase/ClaimTalentPoolCandidateUseCase
   * and playerDto.ts — none of them expose this field). Deliberately
   * independent-ish of the current rarity tier/attributes: a 'common'
   * player CAN roll a high ceiling (the "diamond in the rough" a real
   * scouting system exists to sometimes find), same as a currently
   * 'exceptional' player is usually already near their own ceiling. */
  potentialCeiling: number;
  /** What the talent pool API actually exposes for potential — a
   * coarse tier computed from potentialCeiling with intentional noise
   * baked in at generation time (not recomputed per-request), so
   * scouting is a genuinely imperfect signal: the same candidate
   * always shows the same tier, but that tier is only ~70% likely to
   * be the true one at the midpoint of the generation age range, ±1
   * tier otherwise — see StandardPlayerGenerationPolicy's age-scaled
   * noise for why "70%" isn't a single fixed number anymore. This is
   * the ENTIRE scouting mechanic — there is deliberately no
   * per-manager scouting-skill or accuracy system layered on top (see
   * CLAUDE.md); every manager sees the exact same noisy tier on the
   * exact same candidate. */
  potentialTier: PotentialTier;
  /** Growth-rate stat driving experience-based development (see
   * docs/rocking-rackets-competitive-analysis.md §1c and
   * PlayerDevelopmentPolicy.weeklyTalentIncome): a high-talent player
   * earns more free experience every week and so develops faster toward
   * their (separate) potential ceiling. Generated once, fixed for the
   * player's whole career — talent is innate, unlike experience which is
   * earned. Deliberately INDEPENDENT of the rarity tier and of
   * potentialCeiling: a currently-'common' player can roll high talent
   * (a raw prospect who develops fast) exactly as they can roll a high
   * hidden ceiling, and the two aren't the same axis — talent is HOW
   * FAST they grow, potentialCeiling is HOW FAR. Hidden like
   * potentialCeiling for now (P4); the profile-only ghost-cap projection
   * that surfaces a read on it is P5's job (§3), not this field's. */
  talent: number;
  /** Hidden per-physical-attribute training ceilings — see
   * PhysicalCeilings' doc comment. Generated once, fixed for the
   * player's whole career, and NEVER serialized in any API response
   * (same discipline as potentialCeiling above — grep
   * `physicalCeilings` in any new DTO/route code and it should only
   * ever appear in adapter-internal mapping functions, never in a
   * response body). Each ceiling is anchored to that SPECIFIC
   * attribute's own rolled current value (never below what the player
   * can already do at that attribute), with independent headroom on
   * top — not anchored to the tier band's max the way the overall
   * potentialCeiling is, since this needs to respect each attribute's
   * own individually-rolled starting value, not a shared band. */
  physicalCeilings: PhysicalCeilings;
}

/**
 * Generates a brand-new player from nothing — the talent pool's
 * source of supply, and (per the fairness constraint in
 * CreateCustomPlayerUseCase) also what a Pro manager's "custom player"
 * credit spends on. Same swappable-policy pattern as AgingPolicy/
 * TrainingPolicy (CLAUDE.md's SOLID discipline): the actual rarity
 * curve and skill bands are a tunable game-balance concern, not
 * something baked into whatever consumes a generated player.
 */
export interface PlayerGenerationPolicy {
  generate(random: RandomSource, ageRange: AgeRange): GeneratedPlayer;
}

interface SkillBand {
  min: number;
  max: number;
}

function pick<T>(pool: readonly T[], random: RandomSource): T {
  const index = Math.min(pool.length - 1, Math.floor(random.next() * pool.length));
  return pool[index];
}

/** The TRUE tier a given ceiling maps to, before noise — exported so
 * tests can check the noise roll's behavior against ground truth
 * without duplicating these thresholds. Never called from anywhere
 * that would expose it directly (only StandardPlayerGenerationPolicy's
 * own noisy roll uses it as an input). */
export function tierForPotentialCeiling(ceiling: number): PotentialTier {
  if (ceiling < 55) return 'limited';
  if (ceiling < 70) return 'promising';
  if (ceiling < 85) return 'high';
  return 'elite';
}

const FIRST_NAMES = [
  'Marta', 'João', 'Elena', 'Luca', 'Priya', 'Kenji', 'Amara', 'Diego', 'Sofia', 'Noah',
  'Ingrid', 'Tomás', 'Yuki', 'Zara', 'Mateus', 'Lena', 'Rafael', 'Aisha', 'Viktor', 'Chloe',
] as const;

const LAST_NAMES = [
  'Silva', 'Kowalski', 'Nakamura', 'García', 'Okafor', 'Novak', 'Larsson', 'Dubois', 'Petrov', 'Costa',
  'Müller', 'Santos', 'Ivanova', 'Yamamoto', 'Brennan', 'Vukovic', 'Rossi', 'Andersson', 'Kim', 'Moreau',
] as const;

/** Display-only, same free-text convention as Player.nationality — no
 * attempt to pair names with "matching" nationalities, a deliberate
 * simplification (real-sounding name/nationality correlation isn't
 * worth the added complexity for a display-only flag). */
const NATIONALITIES = [
  'BR', 'US', 'ES', 'FR', 'GB', 'DE', 'IT', 'AR', 'JP', 'AU', 'RS', 'CA', 'SE', 'CZ', 'PT',
] as const;

/**
 * Standard generation curve: most generated players land in a
 * mediocre band, a small slice are genuinely strong, and a rare sliver
 * are exceptional — the "talent pool" should feel like real scouting,
 * where most prospects are ordinary and a standout is a real event.
 *
 * Surface affinities are rolled independently of rarity tier (a
 * player's overall skill level and their surface aptitude are treated
 * as unrelated axes here, matching how hired players already start
 * with flat, tier-independent affinities) — deliberately not part of
 * what "rarity" means in this game, to keep the mental model simple:
 * rarity is about how good a player's core skills are, not their
 * surface fit.
 */
export class StandardPlayerGenerationPolicy implements PlayerGenerationPolicy {
  private static readonly EXCEPTIONAL_PROBABILITY = 0.03;
  private static readonly STRONG_PROBABILITY = 0.17;
  // Remaining ~80% probability falls through to 'common'.

  private static readonly SKILL_BANDS: Record<PlayerRarityTier, SkillBand> = {
    common: { min: 20, max: 42 },
    strong: { min: 48, max: 68 },
    exceptional: { min: 74, max: 94 },
  };

  private static readonly AFFINITY_RANGE: SkillBand = { min: 12, max: 28 };

  /** Mental attributes (consistency, clutch) are generated already
   * mature — see docs/training-redesign-per-attribute.md: "personality
   * isn't coached." Unlike technical/physical, which start at a low
   * youth-tier band and grow through training, mental attributes never
   * train at all, so starting them low would leave every player
   * mentally underdeveloped for their whole career with no way to fix
   * it. This range is independent of rarity tier AND age — a 'common'
   * player can have just as composed a mental game as an 'exceptional'
   * one, matching how this range reads: not clustered near the
   * skill cap (an unearned "everyone is a champion" feel), not
   * clustered low either (a "raw kid" feel that contradicts "already
   * mature") — a broad, credible spread roughly matching how a
   * strong, experienced veteran's mental stats already look under the
   * OLD flat-band system after years of training toward a high
   * ceiling. */
  private static readonly MENTAL_MATURE_MIN = 55;
  private static readonly MENTAL_MATURE_MAX = 90;

  /** Headroom rolled on TOP of the rarity tier's own band max — see
   * this class's generate() for why the ceiling isn't independently
   * rolled from scratch (it's deliberately anchored to the tier band
   * so a player's ceiling is never below what they can already do). */
  private static readonly MAX_POTENTIAL_HEADROOM = 45;
  private static readonly MAX_SKILL = 99;

  /** Per-direction noise probability at the YOUNGEST age an AgeRange
   * can produce — scouting a 14-year-old's long-term ceiling is
   * genuinely harder than scouting a 16-year-old's, real years of
   * development still sit between them and their peak, so the noisy
   * displayed tier is LESS reliable the younger the player is. */
  private static readonly YOUNGEST_NOISE_PROBABILITY = 0.2;
  /** Per-direction noise probability at the OLDEST age an AgeRange can
   * produce — closer to whatever comes after this generation range
   * (today: senior eligibility), so there's less development left to
   * be wrong about. */
  private static readonly OLDEST_NOISE_PROBABILITY = 0.1;
  generate(random: RandomSource, ageRange: AgeRange): GeneratedPlayer {
    const ageInWeeks = this.rollAge(ageRange, random);
    const tier = this.rollTier(random);
    const band = StandardPlayerGenerationPolicy.SKILL_BANDS[tier];
    const rollSkill = () => Skill.of(band.min + random.next() * (band.max - band.min));
    const rollMatureSkill = () =>
      Skill.of(
        StandardPlayerGenerationPolicy.MENTAL_MATURE_MIN +
          random.next() *
            (StandardPlayerGenerationPolicy.MENTAL_MATURE_MAX - StandardPlayerGenerationPolicy.MENTAL_MATURE_MIN),
      );
    const rollAffinity = () => {
      const { min, max } = StandardPlayerGenerationPolicy.AFFINITY_RANGE;
      return Math.round(min + random.next() * (max - min));
    };

    const physical = {
      speed: rollSkill(),
      stamina: rollSkill(),
      strength: rollSkill(),
    };

    const attributes = new PlayerAttributes({
      technical: {
        serve: rollSkill(),
        forehand: rollSkill(),
        backhand: rollSkill(),
        volley: rollSkill(),
      },
      physical,
      // Mental attributes are exempt from the rarity-tier band
      // entirely (see MENTAL_MATURE_MIN/MAX's doc comment) — rolled
      // via rollMatureSkill(), not rollSkill(), so they're independent
      // of both `tier` and `ageInWeeks`.
      mental: {
        consistency: rollMatureSkill(),
        clutch: rollMatureSkill(),
      },
      surfaceAffinities: SurfaceAffinities.of({
        clay: rollAffinity(),
        grass: rollAffinity(),
        hard: rollAffinity(),
        indoor: rollAffinity(),
      }),
    });

    const name = `${pick(FIRST_NAMES, random)} ${pick(LAST_NAMES, random)}`;
    const nationality = pick(NATIONALITIES, random);

    const potentialCeiling = this.rollPotentialCeiling(band, random);
    const potentialTier = this.rollPotentialTier(potentialCeiling, ageInWeeks, ageRange, random);
    const physicalCeilings = this.rollPhysicalCeilings(physical, random);
    const talent = this.rollTalent(random);

    return { name, nationality, tier, attributes, potentialCeiling, potentialTier, ageInWeeks, physicalCeilings, talent };
  }

  private rollAge(ageRange: AgeRange, random: RandomSource): number {
    return Math.round(ageRange.minWeeks + random.next() * (ageRange.maxWeeks - ageRange.minWeeks));
  }

  private rollTier(random: RandomSource): PlayerRarityTier {
    const roll = random.next();
    if (roll < StandardPlayerGenerationPolicy.EXCEPTIONAL_PROBABILITY) return 'exceptional';
    if (roll < StandardPlayerGenerationPolicy.EXCEPTIONAL_PROBABILITY + StandardPlayerGenerationPolicy.STRONG_PROBABILITY) {
      return 'strong';
    }
    return 'common';
  }

  /** Anchored to the rarity band's own max, not rolled independently
   * from zero: a player's hidden ceiling is always at or above the top
   * of their current tier's band (training can't be "worth less than
   * nothing"), with the headroom on top of that being the genuinely
   * unpredictable part — a 'common' player can still roll a big
   * headroom and land an 'elite' true ceiling, same as an 'exceptional'
   * player almost always rolls into 'elite' territory since their
   * band max alone is already close to it. That asymmetry is
   * deliberate: scouting value is highest for currently-unimpressive
   * players, exactly where real scouting matters most. */
  private rollPotentialCeiling(band: SkillBand, random: RandomSource): number {
    const headroom = random.next() * StandardPlayerGenerationPolicy.MAX_POTENTIAL_HEADROOM;
    return Math.min(StandardPlayerGenerationPolicy.MAX_SKILL, Math.round(band.max + headroom));
  }

  /** Three INDEPENDENT rolls, one per physical attribute — not one
   * shared ceiling reused across speed/stamina/strength. Each is
   * anchored to that specific attribute's own already-rolled current
   * value (never below what the player can already do at that
   * attribute), with its own independent headroom on top, same
   * MAX_POTENTIAL_HEADROOM/MAX_SKILL scale as the overall
   * potentialCeiling for consistency. */
  private rollPhysicalCeilings(
    physical: { speed: Skill; stamina: Skill; strength: Skill },
    random: RandomSource,
  ): PhysicalCeilings {
    return {
      speed: this.rollAttributeCeiling(physical.speed.value, random),
      stamina: this.rollAttributeCeiling(physical.stamina.value, random),
      strength: this.rollAttributeCeiling(physical.strength.value, random),
    };
  }

  /** PLACEHOLDER band for the innate talent (growth-rate) stat, rolled
   * uniformly and INDEPENDENTLY of rarity tier / potential (see
   * GeneratedPlayer.talent's doc comment). A broad 25-95 spread so
   * there's a real distribution of "fast learners" vs "slow burners"
   * across the pool regardless of current ability — not clustered high
   * (every prospect a can't-miss project) nor low. Owned by the
   * development tuning pass, same status as MENTAL_MATURE_MIN/MAX. */
  private static readonly TALENT_MIN = 25;
  private static readonly TALENT_MAX = 95;

  private rollTalent(random: RandomSource): number {
    return Math.round(
      StandardPlayerGenerationPolicy.TALENT_MIN +
        random.next() * (StandardPlayerGenerationPolicy.TALENT_MAX - StandardPlayerGenerationPolicy.TALENT_MIN),
    );
  }

  private rollAttributeCeiling(currentValue: number, random: RandomSource): number {
    const headroom = random.next() * StandardPlayerGenerationPolicy.MAX_POTENTIAL_HEADROOM;
    return Math.min(StandardPlayerGenerationPolicy.MAX_SKILL, Math.round(currentValue + headroom));
  }

  /** The noise: at the youngest age an AgeRange can produce, 60% of
   * the time this returns the ceiling's true tier exactly, 20% one
   * step lower, 20% one step higher; at the oldest age, 80%/10%/10% —
   * linearly interpolated in between (clamped at the ends of
   * POTENTIAL_TIER_ORDER) — computed and returned ONCE here, at
   * generation time, so it's a stable, persisted property of the
   * candidate rather than something that could be re-rolled (and thus
   * gamed by re-fetching) on every read. */
  private rollPotentialTier(ceiling: number, ageInWeeks: number, ageRange: AgeRange, random: RandomSource): PotentialTier {
    const trueTier = tierForPotentialCeiling(ceiling);
    const index = POTENTIAL_TIER_ORDER.indexOf(trueTier);
    const noiseProbability = this.noiseProbabilityForAge(ageInWeeks, ageRange);
    const roll = random.next();
    if (roll < noiseProbability) {
      return POTENTIAL_TIER_ORDER[Math.max(0, index - 1)];
    }
    if (roll < noiseProbability * 2) {
      return POTENTIAL_TIER_ORDER[Math.min(POTENTIAL_TIER_ORDER.length - 1, index + 1)];
    }
    return trueTier;
  }

  /** Linear interpolation between YOUNGEST_NOISE_PROBABILITY (at
   * ageRange.minWeeks) and OLDEST_NOISE_PROBABILITY (at
   * ageRange.maxWeeks) — a real, if simple, "scouting is harder for
   * younger prospects" curve, not just a flat number dressed up as one.
   * Uses the shared ageInterpolationFactor (see its own doc comment)
   * rather than a locally re-derived t. */
  private noiseProbabilityForAge(ageInWeeks: number, ageRange: AgeRange): number {
    const t = ageInterpolationFactor(ageInWeeks, ageRange); // 0 at youngest, 1 at oldest
    return (
      StandardPlayerGenerationPolicy.YOUNGEST_NOISE_PROBABILITY -
      t * (StandardPlayerGenerationPolicy.YOUNGEST_NOISE_PROBABILITY - StandardPlayerGenerationPolicy.OLDEST_NOISE_PROBABILITY)
    );
  }
}
