import { GameWeek } from '../shared/ids';
import { AgingStage, Player } from './Player';

export interface AgingCurvePolicy {
  readonly weeksPerYear: number;
  readonly weeklyDeclineAmount: number;
  stageFor(ageInYears: number): AgingStage;
}

/**
 * Illustrative, not balanced — prime/decline/retirement thresholds
 * need a real tuning pass before launch (see CLAUDE.md's "known
 * placeholders" section). `weeksPerYear` is what lets a fast-speed
 * game-world and a slow-speed one run the same policy shape.
 */
export class StandardAgingCurvePolicy implements AgingCurvePolicy {
  readonly weeklyDeclineAmount = 0.15;

  constructor(
    private readonly primeAge = 20,
    private readonly declineAge = 30,
    private readonly retirementAge = 38,
    readonly weeksPerYear = 52,
  ) {}

  stageFor(ageInYears: number): AgingStage {
    if (ageInYears >= this.retirementAge) return 'retired';
    if (ageInYears >= this.declineAge) return 'decline';
    if (ageInYears >= this.primeAge) return 'prime';
    return 'youth';
  }
}

/**
 * Weekly aging/decline domain service, kept separate from the Player
 * aggregate because the aging curve is a swappable *policy* — a
 * fast-speed game-world can run a different curve than a slow one —
 * rather than a fixed rule the entity owns itself (SRP + OCP).
 */
export class PlayerAgingService {
  constructor(private readonly policy: AgingCurvePolicy = new StandardAgingCurvePolicy()) {}

  applyWeeklyTick(player: Player, currentWeek: GameWeek): void {
    if (currentWeek.toNumber() > 0 && currentWeek.toNumber() % this.policy.weeksPerYear === 0) {
      player.growOlder();
    }

    const stage = this.policy.stageFor(player.ageInYears);
    player.transitionTo(stage);

    if (stage === 'decline' || stage === 'retired') {
      player.declinePhysical(this.policy.weeklyDeclineAmount);
    }
  }
}
