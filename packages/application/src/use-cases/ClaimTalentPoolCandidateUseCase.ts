import { ManagerId, Player, PlayerId, TalentClaimPricingPolicy } from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, PlayerRepository, TalentClaimPort } from '../ports/ports';
import { maxRosterSizeFor } from './rosterCap';
import { TALENT_POOL_AGE_RANGE } from './talentPoolAgeRange';

export interface ClaimTalentPoolCandidateCommand {
  playerId: PlayerId;
  managerId: ManagerId;
}

/**
 * Signing a free agent out of the shared talent pool. As of the
 * candidate/player unification (see docs/CLAUDE.md's "hiring is
 * pool-based and scarce" note), a talent-pool "candidate" is no longer a
 * separate aggregate that gets converted into a Player on claim — every
 * prospect IS already a real Player (managerId: null) living in the
 * world for their whole career whether or not anyone ever signs them.
 * Signing is therefore an ownership transfer on an existing player, not
 * the creation of a new one: it sets manager_id and flips fillOnly off
 * (a signed player trains from its manager's schedule, not the auto
 * weakest-attribute path). It still COSTS XP
 * (docs/manager-xp-and-coaching-system.md section 3).
 *
 * Race safety has two dimensions to protect, not one:
 *  1. Two managers signing the same free agent — only one may win.
 *  2. A manager's XP balance check and the deduction can't be separate
 *     steps, or two near-simultaneous signings could both pass the
 *     balance check before either deducts.
 * The roster-cap check below protects neither of these — it only ever
 * knows about ITS OWN caller's roster, same documented, accepted gap as
 * before. The actual guarantee for both dimensions is
 * TalentClaimPort.claimAndCharge()'s single real DB transaction (see
 * DrizzleTalentClaimAdapter) — this use case deliberately does NOT
 * compose a signing from separate player-lookup + XP-check + XP-spend +
 * manager-set calls, since that would reopen exactly the races the port
 * exists to close.
 *
 * The XP price is computed here, before the atomic claimAndCharge call,
 * by reading the free agent's current overallRating() — safe because a
 * player's attributes barely move week-to-week, so pricing off this
 * pre-fetched read stays correct even though the actual sign+charge
 * happens moments later, atomically, possibly against a since-changed
 * owner.
 */
export class ClaimTalentPoolCandidateUseCase {
  constructor(
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

    const player = await this.players.findById(command.playerId);
    if (!player || player.managerId !== null || player.isRetired()) {
      throw new Error(`Free agent ${command.playerId} is no longer available to sign`);
    }
    // TALENT_POOL_AGE_RANGE: the same call-site age window every
    // player-generating flow already imports (RefreshTalentPoolUseCase,
    // CreateCustomPlayerUseCase) — pricing's age-blend is scoped to that
    // exact same range so "youngest"/"oldest" mean the same thing here
    // as everywhere else a generated player's age is judged against it.
    const xpCost = this.pricingPolicy.priceFor(player.attributes.overallRating(), player.ageInWeeks, TALENT_POOL_AGE_RANGE);

    const outcome = await this.talentClaim.claimAndCharge(command.playerId, command.managerId, xpCost);
    if (outcome.kind === 'player-unavailable') {
      throw new Error(`Free agent ${command.playerId} is no longer available to sign`);
    }
    if (outcome.kind === 'insufficient-xp') {
      throw new Error(
        `Manager ${command.managerId} has insufficient XP to sign this free agent ` +
          `(needs ${outcome.required}, has ${outcome.balance})`,
      );
    }

    const signed = outcome.player;
    // The atomic sign path reconstitutes the player straight from the
    // updated row (emitting no aggregate events), so publish the signing
    // fact here rather than pulling it off the aggregate.
    await this.events.publish([{ type: 'PlayerSigned', payload: { playerId: signed.id, managerId: command.managerId } }]);
    return signed;
  }
}
