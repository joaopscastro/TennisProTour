import { PairId, PlayerId } from '../shared/ids';
import { PlayerAttributes, Skill, SurfaceAffinities } from '../player/PlayerAttributes';
import { MatchParticipant } from './MatchSimulator';

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
