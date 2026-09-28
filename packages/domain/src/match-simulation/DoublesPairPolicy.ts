import { PairId, PlayerId } from '../shared/ids';
import { PlayerAttributes, Skill, Surface, SurfaceAffinities } from '../player/PlayerAttributes';
import { MatchParticipant } from './MatchSimulator';
import { weightedTechnicalAverage, weightedPhysicalAverage, weightedMentalAverage } from './SurfaceAttributeWeightingPolicy';
import { DOUBLES_SKILL_WEIGHT, CHEMISTRY_BONUS_PER_POINT } from './StatisticalMatchSimulator';

/**
 * Turns a two-player doubles side into ONE composite `MatchParticipant`
 * (P7b) — the whole trick that lets the existing point-by-point sim
 * stay untouched: a doubles match is still "side A vs side B", only the
 * sides are pairs. Swappable-policy seam (same shape as AgingPolicy/
 * TrainingPolicy): the exact blend (how to average the two players'
 * attributes, whose fatigue/form counts) is a balance decision, not a
 * fact about what a pair *is*.
 */
export interface DoublesPairPolicy {
  compositeParticipant(
    pairId: PairId,
    playerA: MatchParticipant<PlayerId>,
    playerB: MatchParticipant<PlayerId>,
    chemistry?: number,
  ): MatchParticipant<PairId>;
}

function avg(a: Skill, b: Skill): Skill {
  return Skill.of((a.value + b.value) / 2);
}

function avgSurface(a: number, b: number): number {
  return Math.round((a + b) / 2);
}

/** Blends two singles `PlayerAttributes` into one synthetic snapshot —
 * each skill and surface affinity is the mean of the two players'. The
 * composite's own `doubles` skill is also the mean, but note the SIM
 * never reads `attributes.doubles` — the doubles bonus travels on the
 * participant's `doublesSkill` field instead (see
 * StatisticalMatchSimulator.DOUBLES_SKILL_WEIGHT). */
function blendAttributes(a: PlayerAttributes, b: PlayerAttributes): PlayerAttributes {
  return new PlayerAttributes({
    technical: {
      serve: avg(a.technical.serve, b.technical.serve),
      forehand: avg(a.technical.forehand, b.technical.forehand),
      backhand: avg(a.technical.backhand, b.technical.backhand),
      volley: avg(a.technical.volley, b.technical.volley),
    },
    physical: {
      speed: avg(a.physical.speed, b.physical.speed),
      stamina: avg(a.physical.stamina, b.physical.stamina),
      strength: avg(a.physical.strength, b.physical.strength),
    },
    mental: {
      consistency: avg(a.mental.consistency, b.mental.consistency),
      clutch: avg(a.mental.clutch, b.mental.clutch),
    },
    doubles: avg(a.doubles, b.doubles),
    surfaceAffinities: SurfaceAffinities.of({
      clay: avgSurface(a.surfaceAffinities.get('clay'), b.surfaceAffinities.get('clay')),
      grass: avgSurface(a.surfaceAffinities.get('grass'), b.surfaceAffinities.get('grass')),
      hard: avgSurface(a.surfaceAffinities.get('hard'), b.surfaceAffinities.get('hard')),
      indoor: avgSurface(a.surfaceAffinities.get('indoor'), b.surfaceAffinities.get('indoor')),
    }),
  });
}

/**
 * The standard doubles blend — deliberately simple, with every constant
 * a PLACEHOLDER owned by the balance pass:
 *
 * - attributes: the mean of the two players' per-skill values (a pair is
 *   as good as its two players averaged together).
 * - `doublesSkill`: the mean of the two players' doubles skills — fed to
 *   the sim's DOUBLES_SKILL_WEIGHT (RR's "40% of doubles stat").
 * - fatigue: the MAX of the two (a pair is only as fresh as its more
 *   tired member).
 * - form: the mean (both players' rhythm matters).
 * - homeAdvantage: true if EITHER player is home.
 */
export class StandardDoublesPairPolicy implements DoublesPairPolicy {
  compositeParticipant(
    pairId: PairId,
    playerA: MatchParticipant<PlayerId>,
    playerB: MatchParticipant<PlayerId>,
    chemistry = 0,
  ): MatchParticipant<PairId> {
    return {
      playerId: pairId,
      attributes: blendAttributes(playerA.attributes, playerB.attributes),
      fatigue: Math.max(playerA.fatigue, playerB.fatigue),
      form: Math.round((playerA.form + playerB.form) / 2),
      homeAdvantage: (playerA.homeAdvantage ?? false) || (playerB.homeAdvantage ?? false),
      doublesSkill: Math.round((playerA.attributes.doubles.value + playerB.attributes.doubles.value) / 2),
      chemistry,
    };
  }
}

/**
 * One player's contribution to a doubles side's effective rating, on the
 * SAME scale `StatisticalMatchSimulator.effectiveRating` produces for a
 * composite side: the surface-weighted technical/physical/mental blend +
 * the passive surface affinity + the doubles-skill term, with the
 * fatigue/form/home terms deliberately excluded (those are per-match
 * state, not roster strength).
 *
 * This is the doubles FIELD-COMPOSITION measure (docs/balance-tuning-
 * report.md's doubles section) — used to cap free-agent padding so a
 * filler pair is never stronger than the real manager pair it is padding
 * around, and to concentrate the strongest available fillers into the
 * field's top pairs so the opposition is genuinely competitive rather
 * than diluted by a random shuffle. It is NOT serialized anywhere — an
 * internal matchmaking read of already-public current attributes, safe
 * under the value-hiding discipline (no ceiling/potential data).
 */
export function doublesSideStrength(attributes: PlayerAttributes, surface: Surface): number {
  const technical = weightedTechnicalAverage(attributes, surface);
  const physical = weightedPhysicalAverage(attributes, surface);
  const mental = weightedMentalAverage(attributes, surface);
  const surfaceBonus = attributes.surfaceAffinities.get(surface);
  return technical * 0.5 + physical * 0.3 + mental * 0.2 + surfaceBonus * 0.3 + DOUBLES_SKILL_WEIGHT * attributes.doubles.value;
}

/**
 * A formed pair's strength on the same effective-rating scale the sim
 * uses for a composite doubles side: the mean of the two players'
 * `doublesSideStrength` plus the pair's chemistry bonus. Used as the
 * PADDING CAP reference — see `orderDoublesFieldFillers`.
 */
export function doublesPairStrength(
  playerA: PlayerAttributes,
  playerB: PlayerAttributes,
  surface: Surface,
  chemistry = 0,
): number {
  return (doublesSideStrength(playerA, surface) + doublesSideStrength(playerB, surface)) / 2 + CHEMISTRY_BONUS_PER_POINT * chemistry;
}

/** A free-agent candidate for padding a doubles field, with the strength
 * measure above pre-computed by the caller. */
export interface DoublesFieldCandidate {
  playerId: PlayerId;
  strength: number;
}

/**
 * Orders free-agent candidates for padding a doubles field, cap-aware
 * (the measured-fix half of the "doubles is an uncontested economy"
 * finding — see docs/balance-tuning-report.md).
 *
 * `cap` is the strength of the WEAKEST real manager pair in the draw
 * (computed by the caller from `doublesPairStrength`; a fallback is the
 * weakest entrant themselves when no persistent pair exists yet). The
 * ordering is:
 *
 * 1. every candidate whose OWN strength is at or below the cap, strongest
 *    first — because a pair formed from two such players can never exceed
 *    the cap, this is what structurally guarantees anonymous padding is
 *    never stronger than a manager's own pair;
 * 2. only if that under-cap group cannot fill the field, the over-cap
 *    candidates weakest-first (the least likely to break the cap when
 *    paired with each other) — a documented, best-effort fallback that a
 *    real free-agent pool (thousands of players, median far below any
 *    realistic manager pair) essentially never reaches.
 *
 * Callers take candidates from the front until the field is full; the
 * pairing service then pairs padded entrants adjacent in this order, so
 * the strongest available fillers form the top opposing pairs (the
 * counterpart to the old random shuffle, which diluted the whole pool
 * into one weak average pair and let a strong manager pair win every
 * draw — a measured 29-30 doubles titles against largely-filler fields).
 */
export function orderDoublesFieldFillers(
  candidates: ReadonlyArray<DoublesFieldCandidate>,
  cap: number,
): DoublesFieldCandidate[] {
  const byStrength = [...candidates].sort(
    (a, b) => b.strength - a.strength || a.playerId.localeCompare(b.playerId),
  );
  const underCap = byStrength.filter((c) => c.strength <= cap);
  const overCapWeakestFirst = byStrength.filter((c) => c.strength > cap).reverse();
  return [...underCap, ...overCapWeakestFirst];
}
