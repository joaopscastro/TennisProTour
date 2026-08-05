import { PlayerAttributes, Skill, SurfaceAffinities } from './PlayerAttributes';
import { RandomSource } from '../match-simulation/MatchSimulator';

/**
 * How rare a generated player's overall skill band is. Exposed (not
 * just an internal detail of the skill roll) because both the pool
 * browse screen and this policy's own tests need to know which band a
 * generation landed in without re-deriving it from raw skill numbers.
 */
export type PlayerRarityTier = 'common' | 'strong' | 'exceptional';

export interface GeneratedPlayer {
  name: string;
  nationality: string;
  tier: PlayerRarityTier;
  attributes: PlayerAttributes;
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

    return { name, nationality, tier, attributes };
  }

  private rollTier(random: RandomSource): PlayerRarityTier {
    const roll = random.next();
    if (roll < StandardPlayerGenerationPolicy.EXCEPTIONAL_PROBABILITY) return 'exceptional';
    if (roll < StandardPlayerGenerationPolicy.EXCEPTIONAL_PROBABILITY + StandardPlayerGenerationPolicy.STRONG_PROBABILITY) {
      return 'strong';
    }
    return 'common';
  }
}
