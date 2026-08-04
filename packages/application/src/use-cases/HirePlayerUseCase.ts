import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, SurfaceAffinities, Skill } from '@tennis-manager/domain';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, PlayerRepository } from '../ports/ports';

/** Free-tier roster cap (Rocking Rackets' base 2-player scarcity). */
export const FREE_ROSTER_CAP = 2;
/** Manager Pro roster cap. The extra capacity is NOT a flat unlock:
 * per CLAUDE.md principle #1 it's paired with faster stat decay for
 * Pro-managed players (see AdvanceWorldWeekUseCase's accelerated
 * aging path). */
export const PRO_ROSTER_CAP = 4;

export interface HirePlayerCommand {
  playerId: PlayerId;
  name: string;
  /** Display-only (a flag next to the player's name) — see
   * Player.nationality's doc comment. Required here, unlike
   * Player.hire()'s optional/defaulted parameter, since this is the
   * real product entry point and every hired player should have one. */
  nationality: string;
  managerId: ManagerId;
  startingAgeInWeeks: number;
}

/**
 * Use case = application service. It orchestrates: check invariants
 * that span more than one aggregate (roster size limits live here,
 * NOT inside Player, since "how many players can this manager have"
 * is a Manager & Progression concern, not a Player concern), calls
 * domain logic, persists via ports, and publishes resulting events.
 * Zero framework/HTTP/DB code — those live in adapters that call
 * this class.
 */
export class HirePlayerUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly events: EventPublisherPort,
    private readonly billing: BillingPort,
  ) {}

  async execute(command: HirePlayerCommand): Promise<void> {
    const currentRoster = await this.players.findByManager(command.managerId);
    const maxRosterSize = await this.maxRosterSizeFor(command.managerId);

    if (currentRoster.length >= maxRosterSize) {
      throw new Error(
        `Manager ${command.managerId} roster is full (${currentRoster.length}/${maxRosterSize}). ` +
          `Upgrade to Manager Pro for extra roster slots.`,
      );
    }

    const startingAttributes = new PlayerAttributes({
      technical: {
        serve: Skill.of(30),
        forehand: Skill.of(30),
        backhand: Skill.of(30),
        volley: Skill.of(30),
      },
      physical: {
        speed: Skill.of(30),
        stamina: Skill.of(30),
        strength: Skill.of(30),
      },
      mental: {
        consistency: Skill.of(30),
        clutch: Skill.of(30),
      },
      surfaceAffinities: SurfaceAffinities.initial(),
    });

    const player = Player.hire(
      command.playerId,
      command.name,
      command.startingAgeInWeeks,
      startingAttributes,
      command.managerId,
      command.nationality,
    );

    await this.players.save(player);
    await this.events.publish(player.pullDomainEvents());
  }

  /** The real entitlement lookup the earlier injected stub stood in
   * for: Manager Pro subscribers get the extended cap, everyone else
   * the free one. execute() is untouched by the swap (Open/Closed,
   * as the seam intended). */
  private async maxRosterSizeFor(managerId: ManagerId): Promise<number> {
    return (await this.billing.isProSubscriber(managerId)) ? PRO_ROSTER_CAP : FREE_ROSTER_CAP;
  }
}
