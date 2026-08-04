import { PlayerId } from '../shared/ids';

export interface PlayerRankingProps {
  playerId: PlayerId;
  totalPoints: number;
}

/**
 * A player's cumulative ranking points total. Tracked per PLAYER, not
 * per manager — real tennis ranking systems (and the roster dashboard,
 * which shows "#4" next to an individual player) rank players, and a
 * manager's roster is just whichever players happen to be assigned to
 * them right now. The original ManagerRanking aggregate this replaces
 * got that wrong: it accumulated one cumulative total per manager,
 * which double-counts hires/releases (a manager who released a
 * champion and hired a scrub kept the champion's points) and can't
 * answer "what's this specific player's rank," the thing the UI
 * actually needs.
 *
 * Deliberately minimal, same as its predecessor: no invariants beyond
 * "points only ever go up." RankingPointsTable owns the scoring
 * formula (a separate domain concern per CLAUDE.md's SOLID
 * discipline); this aggregate just accumulates whatever it's given.
 * Rank *position* (e.g. "#4") is not stored here — it's relative to
 * every other player's points, so it's computed by the read side
 * (PlayerRankingRepository.findAllSortedByPoints) rather than kept as
 * mutable state on each ranking row.
 */
export class PlayerRanking {
  private constructor(private props: PlayerRankingProps) {}

  static empty(playerId: PlayerId): PlayerRanking {
    return new PlayerRanking({ playerId, totalPoints: 0 });
  }

  /** Rehydrates a persisted ranking (repository adapters only). */
  static reconstitute(props: PlayerRankingProps): PlayerRanking {
    return new PlayerRanking({ ...props });
  }

  get playerId(): PlayerId {
    return this.props.playerId;
  }

  get totalPoints(): number {
    return this.props.totalPoints;
  }

  addPoints(amount: number): void {
    if (amount < 0) {
      throw new Error(`Cannot add negative ranking points: ${amount}`);
    }
    this.props = { ...this.props, totalPoints: this.props.totalPoints + amount };
  }
}
