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

/**
 * The built-in cost of the Manager Pro roster upgrade (CLAUDE.md
 * principle #1, copied from Rocking Rackets' VIP design): extra
 * roster capacity is paired with steeper weekly decline, never a flat
 * unlock. Implemented as a decorator over any base policy so the
 * multiplier composes with whatever curve a game-world runs —
 * exactly the Open/Closed seam the AgingPolicy interface exists for.
 *
 * Stage thresholds are untouched: Pro players decline *faster*, they
 * don't retire *earlier*.
 */
export class AcceleratedDeclinePolicy implements AgingPolicy {
  constructor(
    private readonly base: AgingPolicy,
    private readonly declineMultiplier: number,
  ) {
    if (declineMultiplier < 1) {
      throw new Error('AcceleratedDeclinePolicy must not soften the base policy (multiplier >= 1)');
    }
  }

  weeklyDeclineDelta(stage: PlayerLifecycleStage): number {
    return this.base.weeklyDeclineDelta(stage) * this.declineMultiplier;
  }

  stageForAge(ageInWeeks: number): PlayerLifecycleStage {
    return this.base.stageForAge(ageInWeeks);
  }

  retirementAgeInWeeks(): number {
    return this.base.retirementAgeInWeeks();
  }
}

/**
 * How many in-game weeks until a player at `ageInWeeks`/`stage`
 * transitions to the next lifecycle stage, under the given policy —
 * null if already retired (there is no next stage). Read-only: this
 * never mutates a Player, it's purely what the roster dashboard's
 * "Prime in ~2 seasons" / "Decline in ~4 seasons" hint needs, computed
 * from the SAME policy `PlayerAgingService.advance()` actually runs on
 * (previously duplicated as a set of raw week constants in the
 * frontend — this is that logic's real home).
 *
 * Implemented as a binary search over `stageForAge`, not a lookup of
 * policy-specific thresholds: `AgingPolicy` doesn't expose "when does
 * stage X start," only "what stage is age N," so this works against
 * any policy that satisfies the interface (including a future
 * game-world-speed variant) without needing new interface surface.
 * `stageForAge` is assumed non-decreasing in age, which every current
 * and planned policy satisfies (aging only ever moves forward).
 */
export function weeksUntilNextStage(ageInWeeks: number, stage: PlayerLifecycleStage, policy: AgingPolicy): number | null {
  if (stage === 'retired') return null;
  let lo = ageInWeeks;
  let hi = policy.retirementAgeInWeeks();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (policy.stageForAge(mid) === stage) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - ageInWeeks;
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
      doubles: current.doubles.add(decayPerAttribute),
      surfaceAffinities: current.surfaceAffinities,
    });

    player.advanceWeek(newAge, newStage, decayed);
  }
}
