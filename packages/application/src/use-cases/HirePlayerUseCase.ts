import { Player } from '../../../domain/src/player/Player';
import { PlayerAttributes, SurfaceAffinities, Skill } from '../../../domain/src/player/PlayerAttributes';
import { ManagerId, PlayerId } from '../../../domain/src/shared/ids';
import { EventPublisherPort, PlayerRepository } from '../ports/ports';

export interface HirePlayerCommand {
  playerId: PlayerId;
  name: string;
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
    private readonly maxRosterSizeFor: (managerId: ManagerId) => Promise<number>,
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
    );

    await this.players.save(player);
    await this.events.publish(player.pullDomainEvents());
  }
}
