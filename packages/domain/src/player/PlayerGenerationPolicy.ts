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

export interface GeneratedPlayer {
  name: string;
  nationality: string;
  tier: PlayerRarityTier;
  attributes: PlayerAttributes;
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
   * be the true one, ±1 tier otherwise. This is the ENTIRE scouting
   * mechanic — there is deliberately no per-manager scouting-skill or
   * accuracy system layered on top (see CLAUDE.md); every manager sees
   * the exact same noisy tier on the exact same candidate. */
  potentialTier: PotentialTier;
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
  generate(random: RandomSource): GeneratedPlayer;
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

  /** Headroom rolled on TOP of the rarity tier's own band max — see
   * this class's generate() for why the ceiling isn't independently
   * rolled from scratch (it's deliberately anchored to the tier band
   * so a player's ceiling is never below what they can already do). */
  private static readonly MAX_POTENTIAL_HEADROOM = 45;
  private static readonly MAX_SKILL = 99;

  /** Probability the noisy displayed tier undershoots or overshoots
   * the true one by exactly one step, each direction — the remainder
   * (70%) shows the true tier exactly. This IS the scouting mechanic
   * in full; see GeneratedPlayer.potentialTier's doc comment. */
  private static readonly POTENTIAL_NOISE_PROBABILITY = 0.15;

  generate(random: RandomSource): GeneratedPlayer {
    const tier = this.rollTier(random);
    const band = StandardPlayerGenerationPolicy.SKILL_BANDS[tier];
    const rollSkill = () => Skill.of(band.min + random.next() * (band.max - band.min));
    const rollAffinity = () => {
      const { min, max } = StandardPlayerGenerationPolicy.AFFINITY_RANGE;
      return Math.round(min + random.next() * (max - min));
    };

    const attributes = new PlayerAttributes({
      technical: {
        serve: rollSkill(),
        forehand: rollSkill(),
        backhand: rollSkill(),
        volley: rollSkill(),
      },
      physical: {
        speed: rollSkill(),
        stamina: rollSkill(),
        strength: rollSkill(),
      },
      mental: {
        consistency: rollSkill(),
        clutch: rollSkill(),
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
    const potentialTier = this.rollPotentialTier(potentialCeiling, random);

    return { name, nationality, tier, attributes, potentialCeiling, potentialTier };
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

  /** The noise: 70% of the time this returns the ceiling's true tier
   * exactly, 15% one step lower, 15% one step higher (clamped at the
   * ends of POTENTIAL_TIER_ORDER) — computed and returned ONCE here,
   * at generation time, so it's a stable, persisted property of the
   * candidate rather than something that could be re-rolled (and thus
   * gamed by re-fetching) on every read. */
  private rollPotentialTier(ceiling: number, random: RandomSource): PotentialTier {
    const trueTier = tierForPotentialCeiling(ceiling);
    const index = POTENTIAL_TIER_ORDER.indexOf(trueTier);
    const roll = random.next();
    if (roll < StandardPlayerGenerationPolicy.POTENTIAL_NOISE_PROBABILITY) {
      return POTENTIAL_TIER_ORDER[Math.max(0, index - 1)];
    }
    if (roll < StandardPlayerGenerationPolicy.POTENTIAL_NOISE_PROBABILITY * 2) {
      return POTENTIAL_TIER_ORDER[Math.min(POTENTIAL_TIER_ORDER.length - 1, index + 1)];
    }
    return trueTier;
  }
}
