import { Player, PlayerLifecycleStage } from './Player';
import { PlayerAttributes, Skill } from './PlayerAttributes';

/**
 * Domain service (not a Player method) because aging is a *policy*
 * that the business may want to tune per game-world speed (fast
 * servers vs. slow servers, mirroring Rocking Rackets' multi-speed
 * server model) without touching the Player entity itself.
 *
 * SOLID note: this is the Open/Closed seam for aging. A new
 * `AcceleratedAgingService` for "fast" worlds can be introduced
 * without modifying Player or any consumer that depends on the
 * `AgingPolicy` interface below.
 */
export interface AgingPolicy {
  /** Physical/technical decay applied per week once a player enters
   * the 'decline' stage. Negative number. */
  weeklyDeclineDelta(stage: PlayerLifecycleStage): number;

  /** Age (in weeks) thresholds for stage transitions. */
  stageForAge(ageInWeeks: number): PlayerLifecycleStage;

  retirementAgeInWeeks(): number;
}

export class StandardAgingPolicy implements AgingPolicy {
  // Ages expressed in in-game weeks; a "season" is 52 weeks by convention.
  private readonly PRIME_START_WEEK = 20 * 52;
  private readonly DECLINE_START_WEEK = 30 * 52;
  private readonly RETIREMENT_WEEK = 38 * 52;

  weeklyDeclineDelta(stage: PlayerLifecycleStage): number {
    return stage === 'decline' ? -0.05 : 0;
  }

  stageForAge(ageInWeeks: number): PlayerLifecycleStage {
    if (ageInWeeks >= this.RETIREMENT_WEEK) return 'retired';
    if (ageInWeeks >= this.DECLINE_START_WEEK) return 'decline';
    if (ageInWeeks >= this.PRIME_START_WEEK) return 'prime';
    return 'youth';
  }

  retirementAgeInWeeks(): number {
    return this.RETIREMENT_WEEK;
  }
}

export class PlayerAgingService {
  constructor(private readonly policy: AgingPolicy) {}

  /** Advances a single player by one in-game week. Pure w.r.t. its
   * inputs aside from mutating the passed-in aggregate via its own
   * public methods — no direct field access, so Player's invariants
   * stay enforced by Player itself. */
  advance(player: Player): void {
    const newAge = player.ageInWeeks + 1;
    const newStage = this.policy.stageForAge(newAge);
    const decayPerAttribute = this.policy.weeklyDeclineDelta(newStage);

    const current = player.attributes;
    const decayed = new PlayerAttributes({
      technical: {
        serve: current.technical.serve.add(decayPerAttribute),
        forehand: current.technical.forehand.add(decayPerAttribute),
        backhand: current.technical.backhand.add(decayPerAttribute),
        volley: current.technical.volley.add(decayPerAttribute),
      },
      physical: {
        speed: current.physical.speed.add(decayPerAttribute),
        stamina: current.physical.stamina.add(decayPerAttribute),
        strength: current.physical.strength.add(decayPerAttribute),
      },
      mental: {
        consistency: current.mental.consistency.add(decayPerAttribute),
        clutch: current.mental.clutch.add(decayPerAttribute),
      },
      surfaceAffinities: current.surfaceAffinities,
    });

    player.advanceWeek(newAge, newStage, decayed);
  }
}
