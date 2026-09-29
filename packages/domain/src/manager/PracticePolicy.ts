/**
 * Practice Sessions (P8a, docs/doubles-and-special-formats-plan.md) — the
 * no-form, no-ranking training outlet that pairs with the fatigue/form
 * constraint systems: when a manager doesn't want to risk a real match
 * (which touches form), they can send a player to practice instead,
 * trading a small fatigue cost for development XP and a bit of manager
 * ladder standing. Deliberately a swappable policy (same shape as
 * AgingPolicy/TrainingPolicy) — the exact numbers are balance
 * placeholders owned by the fatigue/form tuning pass.
 *
 * **The ladder credit is BOUNDED PER WEEK** (season-4 fix): the first
 * `ladderSessionsPerWeek()` sessions a player practises in a game week
 * bank `ladderPointsForSession`; every session after that still grants
 * its development XP and costs its fatigue, but banks NO ladder. The
 * original uncapped +15/session was measured as a free, fatigue-negative
 * pump — a player could bank up to 105 ladder/week with no competitive
 * trade-off, and one agent (who never read the source) lost ~2,300
 * ladder points to that ignorance. With the cap, a week of practice is
 * a bounded, visible choice: up to `sessions × points` of ladder
 * (3 × 15 = 45/player/week) while practice keeps its full
 * development-XP role. The cap is PER PLAYER, independent of matches
 * and of entry activity.
 */
export interface PracticePolicy {
  /** Development experience (Player.experience) a practice session
   * grants the player — spent by training to grow skills. Deliberately
   * NOT capped by the weekly ladder cap: practice remains the
   * always-available training outlet. */
  practiceExperience(): number;
  /** Fatigue a practice session costs — small (a real match is
   * `BASE_MATCH_FATIGUE` = 8), since practice is meant to be lighter. */
  practiceFatigue(): number;
  /** How many sessions per player per game week still bank ladder
   * points. Sessions beyond it grant XP/fatigue only. */
  ladderSessionsPerWeek(): number;
  /** Manager LADDER points a practice session banks, given how many
   * sessions THIS player has already practised in the current game week
   * (0-based, i.e. the session number minus one). RR's own practice rule
   * was "15 manager points/win"; this game deliberately bounds how often
   * that can repeat in a week (see this interface's doc comment). */
  ladderPointsForSession(sessionsThisWeek: number): number;
}

/** The standard practice session — every constant a PLACEHOLDER. */
export class StandardPracticePolicy implements PracticePolicy {
  /** Enough to fund roughly a couple of skill points of training. */
  private static readonly EXPERIENCE_PER_SESSION = 2;
  private static readonly FATIGUE_PER_SESSION = 2;
  /** RR's "15 manager points per practice win", unchanged per session. */
  private static readonly LADDER_POINTS_PER_SESSION = 15;
  /** PLACEHOLDER (season-4 bounded-practice fix): at most this many
   * sessions per player per week bank ladder — 45/week/player, down
   * from an unbounded 105. */
  private static readonly LADDER_SESSIONS_PER_WEEK = 3;

  practiceExperience(): number {
    return StandardPracticePolicy.EXPERIENCE_PER_SESSION;
  }

  practiceFatigue(): number {
    return StandardPracticePolicy.FATIGUE_PER_SESSION;
  }

  ladderSessionsPerWeek(): number {
    return StandardPracticePolicy.LADDER_SESSIONS_PER_WEEK;
  }

  ladderPointsForSession(sessionsThisWeek: number): number {
    if (sessionsThisWeek < 0) return StandardPracticePolicy.LADDER_POINTS_PER_SESSION;
    return sessionsThisWeek < StandardPracticePolicy.LADDER_SESSIONS_PER_WEEK
      ? StandardPracticePolicy.LADDER_POINTS_PER_SESSION
      : 0;
  }
}
