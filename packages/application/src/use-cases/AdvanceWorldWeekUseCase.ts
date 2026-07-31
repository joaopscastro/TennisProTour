import { PlayerAgingService, WorldId } from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, PlayerRepository } from '../ports/ports';

export interface AdvanceWorldWeekCommand {
  worldId: WorldId;
  /** External idempotency key for this tick — e.g. the real-world ISO
   * week ("2026-W31") the scheduler fired for. The same key applied
   * twice is a no-op (see GameWorld.advanceWeek). */
  tickKey: string;
}

export interface AdvanceWorldWeekResult {
  advanced: boolean;
  playersAged: number;
}

/**
 * The weekly world tick: advance the world clock one game week and
 * age every player through PlayerAgingService. Idempotency lives in
 * the GameWorld aggregate, not here — the aggregate refuses to apply
 * the same tickKey twice, and this use case bails out before touching
 * any player when it does.
 *
 * Honest limitation, deliberate for now: the per-player saves and the
 * final world save are not one atomic transaction, so a crash mid-run
 * can age some players and leave the tick unrecorded (a rerun would
 * re-age those). The guard protects against the routine failure mode
 * (scheduler double-fire); crash-consistency needs a unit-of-work
 * port and can be added without changing this use case's callers.
 */
export class AdvanceWorldWeekUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly players: PlayerRepository,
    private readonly agingService: PlayerAgingService,
    private readonly events: EventPublisherPort,
  ) {}

  async execute(command: AdvanceWorldWeekCommand): Promise<AdvanceWorldWeekResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);

    if (!world.advanceWeek(command.tickKey)) {
      return { advanced: false, playersAged: 0 };
    }

    const allPlayers = await this.players.findAll();
    for (const player of allPlayers) {
      this.agingService.advance(player);
      await this.players.save(player);
      await this.events.publish(player.pullDomainEvents());
    }

    await this.worlds.save(world);
    return { advanced: true, playersAged: allPlayers.length };
  }
}
