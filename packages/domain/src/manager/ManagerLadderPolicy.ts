/**
 * Domain service seam for the DECAYING manager ranking ladder — the
 * competitive meta-loop (docs/rocking-rackets-competitive-analysis.md
 * §1d/P3), deliberately SEPARATE from ManagerXpPolicy/ManagerXpRepository.
 *
 * The two must not be confused: manager XP is a monotonic, spendable
 * WALLET (claim a prospect, convert a coach) — it never decays and it's
 * not a public standing. The manager LADDER is the opposite: a public,
 * decaying SCORE that answers "am I winning vs other managers?" and can
 * only be held by continuing to play (Rocking Rackets' actual retention
 * hook). Grand Circuit keeps BOTH, exactly as RR does — this policy is
 * the swappable formula for the ladder half, the same pattern as
 * ManagerXpPolicy, RankingPointsTable and TrainingPolicy.
 */
export interface ManagerLadderPolicy {
  /** Ladder points a manager banks for one rostered player's result
   * that earned `rankingPoints` ranking points. RR's model is that a
   * manager accumulates ALL the ranking points their players earn, so
   * the default is identity — but it's a seam so a future tuning pass
   * can weight the ladder differently from the raw ranking table
   * without touching SimulateMatchUseCase. A 0-point result (e.g. a
   * first-round loss) banks 0 — the ladder only ever grows on a real,
   * points-earning win, mirroring the ranking ledger itself. */
  creditFor(rankingPoints: number): number;

  /** Multiplier applied to a manager's WHOLE ladder score once per
   * weekly rollover (never mid-week). E.g. 0.99 = a flat -1%/week
   * erosion. The score never resets, but it always erodes, so holding
   * or climbing the public leaderboard requires continuing to play. */
  weeklyDecayFactor(): number;

  /** An EXTRA, harsher decay multiplier applied — on top of
   * `weeklyDecayFactor`, not instead of it — only to a manager who
   * registered NONE of their rostered players into ANY tournament
   * (singles or doubles) during the week just ended. Inspired by the
   * real ATP rulebook's withdrawal-penalty concept (Chapter IX,
   * 9.03.C — a scheduled-but-skipped ATP 500 costs ranking points),
   * reinterpreted for this game's actual failure mode: not a
   * withdrawal (there is no such action here), but an absentee
   * manager simply forgetting to enter anyone for a whole week. Scoped
   * to the MANAGER LADDER specifically (not the player's own ranking,
   * which already has no equivalent "forced zero" outside the
   * obligatory-major rule) because the ladder is this game's own
   * "come back and stay active" retention mechanic — the natural home
   * for a real activity penalty. */
  inactivityPenaltyFactor(): number;
}

/**
 * Illustrative, not balanced — same placeholder discipline as
 * StandardManagerXpPolicy's BASE_XP/WIN_BONUS and
 * StandardRankingPointsTable's points formula. Safe to ship for
 * validating the architecture and the retention loop, but the decay
 * rate in particular is the kind of number that wants a real tuning
 * pass (and an owner decision on whether it should be tier-gated for
 * new managers — see the analysis doc's open question #2; this
 * implementation uses RR's simpler flat rate).
 */
export class StandardManagerLadderPolicy implements ManagerLadderPolicy {
  /** PLACEHOLDER: RR decays the manager score a flat 1%/week (1.5% for
   * VIP). We use the non-VIP 1% here for everyone — the VIP faster-decay
   * variant is a monetization/fairness lever to wire in with billing,
   * not a core-loop constant. Not tuned. */
  private static readonly WEEKLY_DECAY = 0.99;

  /** PLACEHOLDER: a fully inactive week (zero entries anywhere on the
   * whole roster) costs an EXTRA 5% on top of the routine 1%. Softened
   * 0.85 → 0.95 by the second fatigue/form pass (docs/balance-tuning-
   * report.md): fatigue recovery is now self-limiting, so a deep run
   * settles at a real, finite fatigue instead of pinning at 100 — but
   * that only makes "take a rest week" a viable plan if a rest week
   * isn't itself punished by a 15% score cliff. 5% is still a real,
   * felt consequence (a manager who forgets entirely keeps sliding
   * ~6%/week including the routine decay) without making rest the wrong
   * move at the exact moment the fatigue system starts asking for it.
   * Not tuned against live data — same status as WEEKLY_DECAY. */
  private static readonly INACTIVITY_PENALTY = 0.95;

  creditFor(rankingPoints: number): number {
    return rankingPoints;
  }

  weeklyDecayFactor(): number {
    return StandardManagerLadderPolicy.WEEKLY_DECAY;
  }

  inactivityPenaltyFactor(): number {
    return StandardManagerLadderPolicy.INACTIVITY_PENALTY;
  }
}
