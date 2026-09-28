import { DrawSize, TournamentTier } from './CompetitionTypes';

/**
 * Maps a tournament round to the day (1-based, within the tournament's
 * run) it is played on. This is a swappable *policy* — the same pattern
 * as AgingPolicy/TrainingPolicy — so a fast game-world can pace
 * tournaments differently from a slow one without any caller change.
 *
 * The world clock advances one day per tick (see GameWorld.advanceDay);
 * a tournament plays at most one round per day. Round r's scheduled day
 * is relative to the tournament's own start (day 1 = the tournament's
 * first day), NOT an absolute world day — callers add the tournament's
 * start offset themselves.
 */
export interface TournamentSchedulePolicy {
  /** Whole days a tournament of this tier/drawSize occupies (its final
   * round's scheduled day). One-week tiers fit in <= 7; two-week tiers
   * span up to 14. */
  durationDays(tier: TournamentTier, drawSize: DrawSize): number;

  /** The day (1-based, relative to the tournament's first day) round
   * `roundNumber` is played on. roundNumber is 1..log2(drawSize). */
  roundDay(tier: TournamentTier, drawSize: DrawSize, roundNumber: number): number;
}

/** Tiers that run over two weeks (14 days) with rest days between
 * rounds — the majors and the masters-class capstone. Every other tier
 * (all senior sub-major tiers and every junior j-grade) runs inside a
 * single week, one round per day.
 *
 * THE DEADLINE RULE: a two-week event must start early enough that its
 * FINAL ROUND lands by the season's last day (S1W52 d7) — a final in
 * the next season lands after the season bonus pool has paid out and
 * after the season prize reset, i.e. the result counts for the wrong
 * season (and for the season harness, past its final week entirely).
 *
 * The deadline therefore depends on the event's REAL span, not just the
 * policy's 14-day main-draw `durationDays`:
 *   - a tier that holds QUALIFYING plays `qualifyingRoundCount` extra
 *     days FIRST (the deferred-main-draw model — see roundScheduledDay),
 *     so its span is qualifyingDays + 14. A senior `major` holds 3
 *     qualifying days (128-player field, 16 places): span 17 days, so
 *     the latest in-season start is week 50 (final = S1W52 d3). A
 *     week-51 start would finish on S2W1 d3 — the exact live bug the
 *     52-week agent season hit, where the season's fourth major was
 *     left unplayed at the harness's end. This is why the senior major
 *     phase is 11 (weeks 11/24/37/50).
 *   - a tier with NO qualifying (juniorMasters) spans exactly 14 days,
 *     so week 51 is still the latest valid start (final = S1W52 d7).
 *
 * Both schedule policies that open two-week tiers are bound by this:
 * StandardSeniorTournamentSchedulePolicy keeps `major` off week 51 via
 * its every-13-week phase, and
 * StandardJuniorTournamentSchedulePolicy.isJuniorMastersWeek is week
 * 51. TwoWeekTierScheduling.test.ts checks the rule against the REAL
 * round-day map INCLUDING the qualifying shift.
 */
const TWO_WEEK_TIERS: ReadonlySet<TournamentTier> = new Set<TournamentTier>(['major', 'juniorMasters']);

export function isTwoWeekTier(tier: TournamentTier): boolean {
  return TWO_WEEK_TIERS.has(tier);
}

function totalRounds(drawSize: DrawSize): number {
  return Math.log2(drawSize);
}

/**
 * Standard schedule:
 * - One-week tiers: round r is played on day r (32-draw = 5 rounds on
 *   days 1-5; a week's remaining days go unused — "might not take all
 *   days"). A 128-draw = 7 rounds fills exactly days 1-7.
 * - Two-week tiers: rounds are spread across 14 days via
 *   ceil(r * 14 / numRounds), so a 7-round major plays roughly every
 *   other day over a fortnight (rest days between rounds).
 */
export class StandardTournamentSchedulePolicy implements TournamentSchedulePolicy {
  roundDay(tier: TournamentTier, drawSize: DrawSize, roundNumber: number): number {
    const rounds = totalRounds(drawSize);
    if (roundNumber < 1 || roundNumber > rounds) {
      throw new Error(`Round ${roundNumber} out of range for a ${drawSize}-draw (1..${rounds})`);
    }
    if (isTwoWeekTier(tier)) {
      return Math.ceil((roundNumber * 14) / rounds);
    }
    return roundNumber;
  }

  durationDays(tier: TournamentTier, drawSize: DrawSize): number {
    return this.roundDay(tier, drawSize, totalRounds(drawSize));
  }
}
