import { ManagerId, Player, PlayerId, TalentClaimPricingPolicy, TalentPoolCandidateId } from '@tennis-manager/domain';
import {
  BillingPort,
  EventPublisherPort,
  PlayerRepository,
  TalentClaimPort,
  TalentPoolCandidateRepository,
} from '../ports/ports';
import { maxRosterSizeFor } from './rosterCap';

export interface ClaimTalentPoolCandidateCommand {
  candidateId: TalentPoolCandidateId;
  managerId: ManagerId;
}

/**
 * Replaces HirePlayerUseCase: a manager no longer hires an
 * instant/on-demand player of their own specification — they claim a
 * specific, already-generated candidate out of the shared talent pool
 * (see docs/CLAUDE.md's "hiring is pool-based and scarce" note), and
 * that claim now COSTS XP (docs/manager-xp-and-coaching-system.md
 * section 3) rather than being free.
 *
 * Race safety has two dimensions to protect now, not one:
 *  1. Two managers claiming the same candidate — only one may win.
 *  2. A manager's XP balance check and the deduction can't be separate
 *     steps, or two near-simultaneous claims could both pass the
 *     balance check before either deducts.
 * The roster-cap check below protects neither of these — it only ever
 * knows about ITS OWN caller's roster, same documented, accepted gap
 * as before this feature. The actual guarantee for both dimensions is
 * TalentClaimPort.claimAndCharge()'s single real DB transaction (see
 * DrizzleTalentClaimAdapter) — this use case deliberately does NOT
 * compose a claim from separate candidate-lookup + XP-check + XP-spend
 * + candidate-claim calls, since that would reopen exactly the races
 * the port exists to close.
 *
 * The XP price itself is computed here, before the atomic
 * claimAndCharge call, by reading the candidate's current
 * overallRating() — safe because a candidate's attributes never change
 * after generation (only status/claimedBy do), so pricing off this
 * pre-fetched read stays correct even though the actual claim+charge
 * happens moments later, atomically, possibly against a since-changed
 * status.
 */
export class ClaimTalentPoolCandidateUseCase {
  constructor(
    private readonly candidates: TalentPoolCandidateRepository,
    private readonly players: PlayerRepository,
    private readonly events: EventPublisherPort,
    private readonly billing: BillingPort,
    private readonly talentClaim: TalentClaimPort,
    private readonly pricingPolicy: TalentClaimPricingPolicy,
  ) {}

  async execute(command: ClaimTalentPoolCandidateCommand): Promise<Player> {
    const currentRoster = await this.players.findByManager(command.managerId);
    const maxRosterSize = await maxRosterSizeFor(command.managerId, this.billing);
    if (currentRoster.length >= maxRosterSize) {
      throw new Error(
        `Manager ${command.managerId} roster is full (${currentRoster.length}/${maxRosterSize}). ` +
          `Upgrade to Manager Pro for extra roster slots.`,
      );
    }

    const candidate = await this.candidates.findById(command.candidateId);
    if (!candidate) {
      throw new Error(`Talent pool candidate ${command.candidateId} is no longer available`);
    }
    const xpCost = this.pricingPolicy.priceFor(candidate.attributes.overallRating());

    const outcome = await this.talentClaim.claimAndCharge(command.candidateId, command.managerId, xpCost);
    if (outcome.kind === 'candidate-unavailable') {
      throw new Error(`Talent pool candidate ${command.candidateId} is no longer available`);
    }
    if (outcome.kind === 'insufficient-xp') {
      throw new Error(
        `Manager ${command.managerId} has insufficient XP to claim this candidate ` +
          `(needs ${outcome.required}, has ${outcome.balance})`,
      );
    }

    const claimed = outcome.candidate;
    // The candidate's own id becomes the resulting player's id — a
    // claimed candidate IS that player from here on, so there's no
    // reason to mint a second, unrelated identity for the same entity.
    const player = Player.hire(
      PlayerId(claimed.id),
      claimed.name,
      claimed.ageInWeeks,
      claimed.attributes,
      command.managerId,
      claimed.nationality,
      claimed.potentialCeiling,
    );
    await this.players.save(player);
    await this.events.publish(player.pullDomainEvents());
    return player;
  }
}
