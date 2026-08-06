import { GameWeek } from '../shared/ids';
import { DrawSize, JuniorTier } from './CompetitionTypes';

/** One weekly batch of a single junior grade: `count` separate
 * tournaments of `tier`/`drawSize`, opened for registration (no fixed
 * entrant list) — see GenerateJuniorTournamentsUseCase. */
export interface JuniorOpening {
  readonly tier: JuniorTier;
  readonly drawSize: DrawSize;
  readonly count: number;
}

/**
 * How often, and how many at a time, each junior grade opens for
 * registration — the swappable-policy seam for tuning ladder pacing,
 * same pattern as AgingPolicy/TrainingPolicy/PlayerGenerationPolicy.
 * Deliberately split into two mechanisms, not one:
 *
 * - The six real J-grades (`weeklyOpenings`) are plain open
 *   registration — any eligible player can enter, no gate, matching
 *   how J30 through J500 work today.
 * - `juniorMasters` is NOT open registration at all — it's a fixed,
 *   ranking-gated field (top `juniorMastersDrawSize` players in that
 *   band's CURRENT ranking, invited directly), once a season. This
 *   policy only says WHEN that week is; GenerateJuniorTournamentsUseCase
 *   is what actually reads the live ranking and builds the fixed
 *   entrant list — this interface has no ranking dependency, staying
 *   a pure schedule lookup like every other policy in this codebase.
 */
export interface JuniorTournamentSchedulePolicy {
  /** Regular-grade tournaments to open this week, across both age
   * bands equally (the same six grades work identically for u14 and
   * u16 — see JuniorTier's doc comment). `absoluteWeek` is a
   * continuously incrementing week counter (season * 52 + week, see
   * world/GameWorld.weeksBetween), not GameWeek.week alone, so an
   * every-N-week cadence doesn't reset at each season boundary. */
  weeklyOpenings(absoluteWeek: number): ReadonlyArray<JuniorOpening>;
  /** Whether juniorMasters should be held this GameWeek — once a
   * season, per band. */
  isJuniorMastersWeek(week: GameWeek): boolean;
  /** Draw size for the ranking-gated juniorMasters field — also how
   * many top-ranked players get invited per band. */
  readonly juniorMastersDrawSize: DrawSize;
}

/**
 * PLACEHOLDER cadence/volume numbers — illustrative, not sourced or
 * balanced, same status as StandardRankingPointsTable's round-below-
 * champion values. What IS deliberate, per the brief this implements:
 * strictly decreasing frequency and increasing draw size from J30 up
 * to J500 — lower grades frequent and small (easy to get into and
 * fill), higher grades rare and larger (prestigious, harder to field).
 * `everyNWeeks` values are pairwise divisors of each other (1, 2, 4, 8)
 * so a "big" week (e.g. J500's) always also fires every smaller grade
 * due that week, rather than the schedule ever feeling arbitrary.
 */
const SCHEDULE: ReadonlyArray<JuniorOpening & { everyNWeeks: number }> = [
  { tier: 'j30', drawSize: 16, count: 3, everyNWeeks: 1 },
  { tier: 'j60', drawSize: 16, count: 2, everyNWeeks: 1 },
  { tier: 'j100', drawSize: 32, count: 1, everyNWeeks: 1 },
  { tier: 'j200', drawSize: 32, count: 1, everyNWeeks: 2 },
  { tier: 'j300', drawSize: 64, count: 1, everyNWeeks: 4 },
  { tier: 'j500', drawSize: 64, count: 1, everyNWeeks: 8 },
];

export class StandardJuniorTournamentSchedulePolicy implements JuniorTournamentSchedulePolicy {
  readonly juniorMastersDrawSize: DrawSize = 16;

  weeklyOpenings(absoluteWeek: number): ReadonlyArray<JuniorOpening> {
    return SCHEDULE.filter((row) => absoluteWeek % row.everyNWeeks === 0).map((row) => ({
      tier: row.tier,
      drawSize: row.drawSize,
      count: row.count,
    }));
  }

  isJuniorMastersWeek(week: GameWeek): boolean {
    return week.week === 52;
  }
}
