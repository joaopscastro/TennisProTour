import { Coach, CoachConversionPolicy, CoachId, ManagerId, PlayerId } from '@tennis-manager/domain';
import { BillingPort, CoachConversionPort, CoachRepository, EventPublisherPort, IdGeneratorPort, PlayerRepository } from '../ports/ports';
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
 * **The multi-write step is now ATOMIC** via `CoachConversionPort`
 * (DrizzleCoachConversionAdapter): spending the XP, releasing the
 * player, dissolving their doubles pairs, and creating the coach all
 * happen in ONE DB transaction, so a failure can never leave XP spent
 * with no coach (the old, disclosed bug — three separate writes with a
 * mid-sequence failure window). The reads below (ownership, capacity,
 * pricing) stay here.
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
 * Remaining disclosed gap: the CAP check above is still a plain
 * check-then-act (not covered by the transaction), so two
 * near-simultaneous conversions by the same manager could theoretically
 * both pass the cap check before either coach is saved, exceeding the
 * cap by one. The XP spend itself can never overspend (the port's
 * conditional UPDATE guarantees it). Tightening the cap needs the same
 * kind of atomic-guard treatment; out of scope for this pass.
 */
export class ConvertPlayerToCoachUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly coaches: CoachRepository,
    private readonly conversionPolicy: CoachConversionPolicy,
    private readonly idGenerator: IdGeneratorPort,
    private readonly events: EventPublisherPort,
    private readonly billing: BillingPort,
    private readonly conversion: CoachConversionPort,
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
    const coachRating = this.conversionPolicy.coachRatingFor(overallRating, ageInWeeks);

    const outcome = await this.conversion.convertAndCharge({
      playerId: command.playerId,
      managerId: command.managerId,
      coachId: CoachId(this.idGenerator.generate()),
      xpCost,
      coachRating,
      sourcePlayerName: player.name,
    });

    if (outcome.kind === 'insufficient-xp') {
      throw new Error(
        `Manager ${command.managerId} has insufficient XP to convert this player to a coach ` +
          `(needs ${outcome.required}, has ${outcome.balance})`,
      );
    }
    if (outcome.kind === 'player-unavailable') {
      throw new Error(`Player ${command.playerId} is not on manager ${command.managerId}'s roster`);
    }

    // The atomic path reconstitutes the coach straight from the
    // transaction's row (emitting no aggregate events), so publish the
    // conversion fact here rather than pulling it off the aggregate.
    await this.events.publish([
      {
        type: 'PlayerConvertedToCoach',
        payload: { coachId: outcome.coach.id, managerId: command.managerId, sourcePlayerId: command.playerId, coachRating: outcome.coach.coachRating },
      },
    ]);

    return outcome.coach;
  }
}
