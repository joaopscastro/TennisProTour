import { GameWeek, WorldId } from '../shared/ids';

export const WEEKS_PER_SEASON = 52;
export const DAYS_PER_WEEK = 7;

/**
 * A point in in-game time at day resolution. Extends GameWeek with a
 * 1..7 `day` within the week — a GameDay is structurally a GameWeek
 * plus a day, so it is still a valid GameWeek for every weekly system
 * (ranking's 52-week window, aging, training) that only reads
 * season/week. Days exist to pace tournaments (1 round/day) and drive
 * fatigue/form; they deliberately do NOT change aging or ranking math.
 * See docs/day-tick-and-scheduling.md.
 */
export interface GameDay extends GameWeek {
  readonly day: number;
}

/** Absolute day index (1-based within the earliest modeled week) so
 * callers never hand-roll week/day carry logic — the day analogue of
 * weeksBetween's absolute-week arithmetic. */
function absoluteDay(point: GameDay): number {
  return (point.season * WEEKS_PER_SEASON + (point.week - 1)) * DAYS_PER_WEEK + point.day;
}

/** Signed number of in-game days from `earlier` to `later` (negative
 * if reversed). The day analogue of weeksBetween. */
export function daysBetween(earlier: GameDay, later: GameDay): number {
  return absoluteDay(later) - absoluteDay(earlier);
}

/** The GameDay `delta` days after `point` (or before, for a negative
 * delta), rolling week and season boundaries the same way advanceDay()
 * does one day at a time — the inverse of daysBetween
 * (`addDays(d, daysBetween(d, x)) === x`). */
export function addDays(point: GameDay, delta: number): GameDay {
  const absolute = absoluteDay(point) + delta;
  const dayIndexZeroBased = absolute - 1;
  const day = (((dayIndexZeroBased % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK) + 1;
  const totalWeeksZeroBased = Math.floor(dayIndexZeroBased / DAYS_PER_WEEK);
  const season = Math.floor(totalWeeksZeroBased / WEEKS_PER_SEASON);
  const week = totalWeeksZeroBased - season * WEEKS_PER_SEASON + 1;
  return { season, week, day };
}

/** Signed number of in-game weeks from `earlier` to `later` (negative
 * if `later` is actually the earlier of the two) — plain integer
 * arithmetic over each GameWeek's absolute week index
 * (season * WEEKS_PER_SEASON + week), so callers never hand-roll
 * season/week carry logic themselves. Shared by anything that needs a
 * rolling-window comparison against GameWeek (ranking's 52-week
 * window, the talent pool's 2-week expiry). */
export function weeksBetween(earlier: GameWeek, later: GameWeek): number {
  const absolute = (week: GameWeek) => week.season * WEEKS_PER_SEASON + week.week;
  return absolute(later) - absolute(earlier);
}

/** The GameWeek `delta` weeks after `week` (or before, for a negative
 * delta), rolling season boundaries the same way `advanceWeek()` does
 * one week at a time — the inverse operation of weeksBetween (`addWeeks(w,
 * weeksBetween(w, x)) === x`). Weeks are 1-indexed within a season (see
 * advanceWeek), so this works over the same absolute-week arithmetic
 * weeksBetween already uses rather than hand-rolling season/week carry
 * logic a second time. */
export function addWeeks(week: GameWeek, delta: number): GameWeek {
  const absolute = week.season * WEEKS_PER_SEASON + week.week + delta;
  const season = Math.floor((absolute - 1) / WEEKS_PER_SEASON);
  const weekInSeason = absolute - season * WEEKS_PER_SEASON;
  return { season, week: weekInSeason };
}

export interface GameWorldProps {
  id: WorldId;
  currentWeek: GameWeek;
  /** Day within the current week, 1..7. Advances one per day tick;
   * rolls back to 1 as currentWeek advances. Optional on
   * reconstitute (defaults to 1) for worlds/tests created before the
   * day clock existed. */
  currentDay?: number;
  /** The external tick key (e.g. an ISO real-world week like
   * "2026-W31") whose advance has already been applied. This is the
   * idempotency guard for the weekly job: the same tick can fire the
   * job twice (retry, redeploy, duplicate scheduler) without the
   * world advancing twice. */
  lastAppliedTick: string | null;
}

/**
 * The world clock for one game-world. Owns two rules: game time only
 * moves forward one week at a time (rolling seasons over at
 * WEEKS_PER_SEASON), and a given external tick advances the world at
 * most once. Everything else (aging players, simulating matches) keys
 * off the week this aggregate says it is — the domain never reads
 * wall-clock time directly (see ClockPort).
 */
export class GameWorld {
  private props: GameWorldProps & { currentDay: number };

  private constructor(props: GameWorldProps) {
    this.props = { ...props, currentDay: props.currentDay ?? 1 };
  }

  static create(id: WorldId, startWeek: GameWeek): GameWorld {
    return new GameWorld({ id, currentWeek: startWeek, currentDay: 1, lastAppliedTick: null });
  }

  /** Rehydration for repository adapters — no events, no rule checks. */
  static reconstitute(props: GameWorldProps): GameWorld {
    return new GameWorld({ ...props });
  }

  get id(): WorldId {
    return this.props.id;
  }

  get currentWeek(): GameWeek {
    return this.props.currentWeek;
  }

  get currentDay(): number {
    return this.props.currentDay;
  }

  /** The full day-resolution clock — a GameDay, still usable anywhere a
   * GameWeek is expected (it structurally extends GameWeek). */
  get currentGameDay(): GameDay {
    return { ...this.props.currentWeek, day: this.props.currentDay };
  }

  get lastAppliedTick(): string | null {
    return this.props.lastAppliedTick;
  }

  /**
   * Advances the world by one game week for the given external tick.
   * Returns false (and changes nothing) when this tick was already
   * applied — the caller must treat that as "skip all per-week work."
   *
   * Retained for callers/tests that still model time weekly; the day
   * tick (advanceDay) is the primitive the worker uses. Advancing a
   * week resets the day to 1.
   */
  advanceWeek(tickKey: string): boolean {
    if (this.props.lastAppliedTick === tickKey) {
      return false;
    }
    const { season, week } = this.props.currentWeek;
    const nextWeek: GameWeek =
      week >= WEEKS_PER_SEASON ? { season: season + 1, week: 1 } : { season, week: week + 1 };
    this.props = { ...this.props, currentWeek: nextWeek, currentDay: 1, lastAppliedTick: tickKey };
    return true;
  }

  /**
   * Advances the world by one game DAY for the given external tick.
   * Returns `advanced: false` (changing nothing) when this tick was
   * already applied. `weekRolledOver` is true exactly when the day
   * wrapped 7 → 1 and the week (and possibly season) advanced — the
   * signal the caller uses to run once-a-week work (aging, training,
   * pool refresh, junior generation) on top of the daily work.
   */
  advanceDay(tickKey: string): { advanced: boolean; weekRolledOver: boolean } {
    if (this.props.lastAppliedTick === tickKey) {
      return { advanced: false, weekRolledOver: false };
    }
    if (this.props.currentDay < DAYS_PER_WEEK) {
      this.props = { ...this.props, currentDay: this.props.currentDay + 1, lastAppliedTick: tickKey };
      return { advanced: true, weekRolledOver: false };
    }
    const { season, week } = this.props.currentWeek;
    const nextWeek: GameWeek =
      week >= WEEKS_PER_SEASON ? { season: season + 1, week: 1 } : { season, week: week + 1 };
    this.props = { ...this.props, currentWeek: nextWeek, currentDay: 1, lastAppliedTick: tickKey };
    return { advanced: true, weekRolledOver: true };
  }
}
