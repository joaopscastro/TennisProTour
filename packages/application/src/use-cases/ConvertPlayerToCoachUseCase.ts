import { Coach, CoachConversionPolicy, CoachId, ManagerId, PlayerId } from '@tennis-manager/domain';
import { CoachRepository, EventPublisherPort, IdGeneratorPort, ManagerXpRepository, PlayerRepository } from '../ports/ports';

/** PLACEHOLDER cap, free tier: a manager may have at most this many
 * coaches at once. Whether Manager Pro should raise this (mirroring
 * the roster-slot cap's free/Pro split — see rosterCap.ts) is an OPEN
 * monetization question explicitly NOT decided here — do not assume
 * Pro raises it without separate confirmation. This constant is
 * intentionally NOT threaded through BillingPort the way
 * maxRosterSizeFor is, so raising it later is a clear, deliberate
 * follow-up rather than something that silently falls out of this cap
 * living in the wrong place. */
export const COACH_CAP_PER_MANAGER = 1;

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
 * Race safety note, stated honestly rather than silently glossed over:
 * unlike ClaimTalentPoolCandidateUseCase (which the user's own
 * concurrency-test requirement was explicitly scoped to), the
 * COACH_CAP_PER_MANAGER check below is a plain check-then-act, NOT
 * protected by an atomic conditional UPDATE the way the XP spend
 * itself is (spendXpIfSufficient still guarantees a manager can never
 * overspend their XP balance even under a cap race). Two
 * near-simultaneous conversions by the same manager could theoretically
 * both pass the cap check before either coach is saved, exceeding the
 * cap by one. This mirrors an existing, already-accepted gap in this
 * codebase (the roster-size cap check in ClaimTalentPoolCandidateUseCase
 * has the exact same shape) — worth tightening later with the same
 * kind of atomic-guard treatment if it matters in practice, but out of
 * scope for this pass.
 */
export class ConvertPlayerToCoachUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly coaches: CoachRepository,
    private readonly managerXp: ManagerXpRepository,
    private readonly conversionPolicy: CoachConversionPolicy,
    private readonly idGenerator: IdGeneratorPort,
    private readonly events: EventPublisherPort,
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
    if (existingCoaches.length >= COACH_CAP_PER_MANAGER) {
      throw new Error(
        `Manager ${command.managerId} already has ${existingCoaches.length}/${COACH_CAP_PER_MANAGER} coaches`,
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
