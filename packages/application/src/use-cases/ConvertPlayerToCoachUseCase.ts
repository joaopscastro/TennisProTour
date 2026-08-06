import { Coach, CoachConversionPolicy, CoachId, ManagerId, PlayerId } from '@tennis-manager/domain';
import { BillingPort, CoachRepository, EventPublisherPort, IdGeneratorPort, ManagerXpRepository, PlayerRepository } from '../ports/ports';
import { maxCoachCountFor } from './coachCap';

export interface ConvertPlayerToCoachCommand {
  playerId: PlayerId;
  managerId: ManagerId;
}

/**
 * Converts a rostered player into a coach — a real, consequential,
 * PERMANENT decision (docs/manager-xp-and-coaching-system.md section
 * 4): the player leaves the roster entirely (their slot becomes free
 * again), XP is spent (cost scaling with the player's ability AND age
 * at conversion, via CoachConversionPolicy), and a new Coach is created
 * whose single coachRating likewise derives from that same ability +
 * age (an older, more accomplished player costs more but produces a
 * better coach). There is deliberately no release/undo path for a
 * Coach once created — see Coach's own doc comment.
 *
 * Coach cap: free tier is capped at FREE_COACH_CAP (1); Manager Pro
 * raises it to PRO_COACH_CAP (2) — see coachCap.ts. This is a
 * DELIBERATE, DISCLOSED exception to CLAUDE.md principle #1's usual
 * "money never buys an unconditional win-rate boost" rule, not an
 * oversight — see coachCap.ts's own doc comment and CLAUDE.md
 * principle #1 for the full disclosure. Pro status is checked the
 * exact same way roster-slot capacity already is (maxRosterSizeFor in
 * rosterCap.ts) — one BillingPort.isProSubscriber() call, no new
 * pattern invented for it.
 *
 * Race safety note, stated honestly rather than silently glossed over:
 * unlike ClaimTalentPoolCandidateUseCase (which the user's own
 * concurrency-test requirement was explicitly scoped to), the coach
 * cap check below is a plain check-then-act, NOT protected by an
 * atomic conditional UPDATE the way the XP spend itself is
 * (spendXpIfSufficient still guarantees a manager can never overspend
 * their XP balance even under a cap race). Two near-simultaneous
 * conversions by the same manager could theoretically both pass the
 * cap check before either coach is saved, exceeding the cap by one.
 * This mirrors an existing, already-accepted gap in this codebase (the
 * roster-size cap check in ClaimTalentPoolCandidateUseCase has the
 * exact same shape) — worth tightening later with the same kind of
 * atomic-guard treatment if it matters in practice, but out of scope
 * for this pass.
 */
export class ConvertPlayerToCoachUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly coaches: CoachRepository,
    private readonly managerXp: ManagerXpRepository,
    private readonly conversionPolicy: CoachConversionPolicy,
    private readonly idGenerator: IdGeneratorPort,
    private readonly events: EventPublisherPort,
    private readonly billing: BillingPort,
  ) {}

  async execute(command: ConvertPlayerToCoachCommand): Promise<Coach> {
    const player = await this.players.findById(command.playerId);
    if (!player) {
      throw new Error(`Player ${command.playerId} not found`);
    }
    if (player.managerId !== command.managerId) {
      throw new Error(`Player ${command.playerId} is not on manager ${command.managerId}'s roster`);
    }

    const existingCoaches = await this.coaches.findByManager(command.managerId);
    const maxCoaches = await maxCoachCountFor(command.managerId, this.billing);
    if (existingCoaches.length >= maxCoaches) {
      throw new Error(
        `Manager ${command.managerId} already has ${existingCoaches.length}/${maxCoaches} coaches. ` +
          `Upgrade to Manager Pro for a second coach slot.`,
      );
    }

    const overallRating = player.attributes.overallRating();
    const ageInWeeks = player.ageInWeeks;
    const xpCost = this.conversionPolicy.conversionCostFor(overallRating, ageInWeeks);

    const spent = await this.managerXp.spendXpIfSufficient(command.managerId, xpCost);
    if (!spent) {
      const balance = await this.managerXp.balanceFor(command.managerId);
      throw new Error(
        `Manager ${command.managerId} has insufficient XP to convert this player to a coach (needs ${xpCost}, has ${balance})`,
      );
    }

    const coachRating = this.conversionPolicy.coachRatingFor(overallRating, ageInWeeks);

    // The player leaves the roster entirely — their slot becomes free
    // again (see Coach's doc comment on why this is a one-way move).
    player.releaseFromManager();
    await this.players.save(player);

    const coach = Coach.convert(CoachId(this.idGenerator.generate()), command.managerId, coachRating, player.id, player.name);
    await this.coaches.save(coach);
    await this.events.publish(coach.pullDomainEvents());

    return coach;
  }
}
