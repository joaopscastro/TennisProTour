import { GameWeek, WorldId } from '../shared/ids';

export const WEEKS_PER_SEASON = 52;

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

export interface GameWorldProps {
  id: WorldId;
  currentWeek: GameWeek;
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
  private constructor(private props: GameWorldProps) {}

  static create(id: WorldId, startWeek: GameWeek): GameWorld {
    return new GameWorld({ id, currentWeek: startWeek, lastAppliedTick: null });
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

  get lastAppliedTick(): string | null {
    return this.props.lastAppliedTick;
  }

  /**
   * Advances the world by one game week for the given external tick.
   * Returns false (and changes nothing) when this tick was already
   * applied — the caller must treat that as "skip all per-week work."
   */
  advanceWeek(tickKey: string): boolean {
    if (this.props.lastAppliedTick === tickKey) {
      return false;
    }
    const { season, week } = this.props.currentWeek;
    const nextWeek: GameWeek =
      week >= WEEKS_PER_SEASON ? { season: season + 1, week: 1 } : { season, week: week + 1 };
    this.props = { ...this.props, currentWeek: nextWeek, lastAppliedTick: tickKey };
    return true;
  }
}
