import { ManagerId, Player, PlayerId, TalentPoolCandidateId } from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, PlayerRepository, TalentPoolCandidateRepository } from '../ports/ports';
import { maxRosterSizeFor } from './rosterCap';

/** Every generated/claimed/custom player starts at the same fixed age
 * — deliberately not caller-supplied (the earlier HirePlayerUseCase
 * this replaces let the client pick an arbitrary starting age, which
 * never had a real design reason behind it). 18 years sits solidly in
 * StandardAgingPolicy's 'youth' stage (prime starts at 20). */
export const STARTING_AGE_IN_WEEKS = 18 * 52;

export interface ClaimTalentPoolCandidateCommand {
  candidateId: TalentPoolCandidateId;
  managerId: ManagerId;
}

/**
 * Replaces HirePlayerUseCase: a manager no longer hires an
 * instant/on-demand player of their own specification — they claim a
 * specific, already-generated candidate out of the shared talent pool
 * (see docs/CLAUDE.md's "hiring is pool-based and scarce" note).
 *
 * Race safety is the core concern here, not a nice-to-have: two
 * managers could click "claim" on the same candidate within
 * milliseconds of each other. The roster-cap check below is NOT what
 * prevents a double-claim — it can't be, since it only knows about
 * ITS OWN caller's roster. The actual guarantee is
 * TalentPoolCandidateRepository.claimIfAvailable()'s single atomic
 * conditional UPDATE: only one of two concurrent calls for the same
 * candidate id can ever get a non-null result back, full stop,
 * regardless of what order the roster-cap checks ran in.
 */
export class ClaimTalentPoolCandidateUseCase {
  constructor(
    private readonly candidates: TalentPoolCandidateRepository,
    private readonly players: PlayerRepository,
    private readonly events: EventPublisherPort,
    private readonly billing: BillingPort,
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

    const claimed = await this.candidates.claimIfAvailable(command.candidateId, command.managerId);
    if (!claimed) {
      throw new Error(`Talent pool candidate ${command.candidateId} is no longer available`);
    }

    // The candidate's own id becomes the resulting player's id — a
    // claimed candidate IS that player from here on, so there's no
    // reason to mint a second, unrelated identity for the same entity.
    const player = Player.hire(
      PlayerId(claimed.id),
      claimed.name,
      STARTING_AGE_IN_WEEKS,
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
