/**
 * Practice Sessions (P8a, docs/doubles-and-special-formats-plan.md) — the
 * no-form, no-ranking training outlet that pairs with the fatigue/form
 * constraint systems: when a manager doesn't want to risk a real match
 * (which touches form), they can send a player to practice instead,
 * trading a small fatigue cost for development XP and a bit of manager
 * ladder standing. Deliberately a swappable policy (same shape as
 * AgingPolicy/TrainingPolicy) — the exact numbers are balance
 * placeholders owned by the fatigue/form tuning pass.
 */
export interface PracticePolicy {
  /** Development experience (Player.experience) a practice session
   * grants the player — spent by training to grow skills. */
  practiceExperience(): number;
  /** Fatigue a practice session costs — small (a real match is
   * `BASE_MATCH_FATIGUE` = 8), since practice is meant to be lighter. */
  practiceFatigue(): number;
  /** Manager LADDER points a practice session banks (not XP — the ladder
   * is the public standing, and RR's own practice rule was "15 manager
   * points/win"). */
  ladderPoints(): number;
}

/** The standard practice session — every constant a PLACEHOLDER. */
export class StandardPracticePolicy implements PracticePolicy {
  /** Enough to fund roughly a couple of skill points of training. */
  practiceExperience(): number {
    return 2;
  }

  practiceFatigue(): number {
    return 2;
  }

  ladderPoints(): number {
    return 15;
  }
}
