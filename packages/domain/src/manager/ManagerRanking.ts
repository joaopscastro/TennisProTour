import { ManagerId } from '../shared/ids';

export interface ManagerRankingProps {
  managerId: ManagerId;
  totalPoints: number;
}

/**
 * A manager's cumulative ranking points total — the first real code
 * for the Manager & Progression bounded context (CLAUDE.md context
 * #4, previously unstarted). Deliberately minimal: no invariants
 * beyond "points only ever go up," since that's genuinely all this
 * aggregate is responsible for. RankingPointsTable owns the scoring
 * formula (a separate domain concern per CLAUDE.md's SOLID
 * discipline); this aggregate just accumulates whatever it's given.
 */
export class ManagerRanking {
  private constructor(private props: ManagerRankingProps) {}

  static empty(managerId: ManagerId): ManagerRanking {
    return new ManagerRanking({ managerId, totalPoints: 0 });
  }

  /** Rehydrates a persisted ranking (repository adapters only). */
  static reconstitute(props: ManagerRankingProps): ManagerRanking {
    return new ManagerRanking({ ...props });
  }

  get managerId(): ManagerId {
    return this.props.managerId;
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
