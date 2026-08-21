import { PlayerId } from '../shared/ids';

/** One player's total senior-tour ranking points earned during a
 * single concluded season — the input the bonus pool ranks by. Built
 * by the application layer from the ranking ledger (see
 * PaySeasonBonusPoolUseCase), never stored anywhere itself. */
export interface SeasonStanding {
  readonly playerId: PlayerId;
  readonly points: number;
}

/** One player's season-end bonus, with the rank it was earned at (for
 * an honest "you finished #N" display). */
export interface SeasonBonusPayout {
  readonly playerId: PlayerId;
  readonly rank: number;
  readonly amount: number;
}

export interface SeasonBonusPoolPolicy {
  computePayouts(standings: ReadonlyArray<SeasonStanding>): SeasonBonusPayout[];
}

/**
 * The season-end bonus pool (per Chapter 1 of the 2026 ATP Circuit
 * Regulations, §1.08.G/H — the real "ATP Tour 500 Fixed Bonus Pool" /
 * "ATP Tour Masters 1000 & Nitto ATP Finals Fixed Bonus Pool"): a
 * standings race by ranking points earned during the season, paying a
 * lump-sum bonus to the top finishers at year-end — on top of, not
 * instead of, the per-tournament prize money already paid throughout
 * the season (see StandardPrizeMoneyTable).
 *
 * Deliberately SIMPLIFIED from the real rule in three ways, each a
 * conscious scope decision, not an oversight:
 * 1. **One pool, not split by tier.** Real ATP runs SEPARATE bonus
 *    pools per category (500s, Masters 1000s) with different eligibility
 *    (a swing-commitment requirement, a "must play the mandatory
 *    events" condition, injury exceptions, etc.) — none of which maps
 *    to anything this game models (there's no swing/commitment concept
 *    here). This is ONE pool, standings drawn from ALL senior-tour
 *    points earned in the season (every senior tier, `ageBand: null`),
 *    same "keep it simple" reasoning CLAUDE.md's principle #2 applies
 *    elsewhere.
 * 2. **Fixed dollar amounts per rank, not a 70/30 fixed-plus-value-per-
 *    point split.** The real rule's value-per-point component requires
 *    knowing the TOTAL points earned by every eligible player across
 *    the whole tour before it can be computed — a real mechanic, but
 *    real complexity for a first pass. A flat table by finishing rank
 *    (same shape MASTERS_CUP_CHAMPION_POINTS-style constants already
 *    use elsewhere in this codebase) captures the core "top players get
 *    paid extra for a strong season" idea without it.
 * 3. **Top 10, not top 30.** Scaled to this game's smaller,
 *    single-world player population — a top-30 payout table would
 *    reach deep into a roster that likely doesn't have 30 active senior
 *    players in every world.
 *
 * All PAYOUT_BY_RANK amounts are explicit PLACEHOLDER dollar figures
 * (same status as StandardPrizeMoneyTable's), not sourced or tuned —
 * this policy establishes the mechanism; balancing it is a later pass.
 * A player with a genuine tie in season points is broken by playerId
 * (a disclosed, arbitrary but deterministic tiebreak — real ATP's own
 * tiebreak chain, "most events played" etc., has no equivalent to draw
 * on here). A player who earned ZERO senior-tour points this season is
 * never eligible for a payout, however few players are ranked at all —
 * same "a bonus must be earned by a real result" spirit as ranking
 * points' own house rule.
 */
export class StandardSeasonBonusPoolPolicy implements SeasonBonusPoolPolicy {
  private static readonly PAYOUT_BY_RANK: ReadonlyArray<number> = [
    500000, 300000, 200000, 150000, 100000, 75000, 50000, 35000, 25000, 15000,
  ];

  computePayouts(standings: ReadonlyArray<SeasonStanding>): SeasonBonusPayout[] {
    const eligible = [...standings].filter((s) => s.points > 0);
    eligible.sort((a, b) => b.points - a.points || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));

    const payouts: SeasonBonusPayout[] = [];
    for (let i = 0; i < eligible.length && i < StandardSeasonBonusPoolPolicy.PAYOUT_BY_RANK.length; i++) {
      payouts.push({ playerId: eligible[i].playerId, rank: i + 1, amount: StandardSeasonBonusPoolPolicy.PAYOUT_BY_RANK[i] });
    }
    return payouts;
  }
}
