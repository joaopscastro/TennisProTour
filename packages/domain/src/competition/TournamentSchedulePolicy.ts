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
 * single week, one round per day. */
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
