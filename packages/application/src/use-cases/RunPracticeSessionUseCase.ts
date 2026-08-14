import { ManagerId, PlayerId, PracticePolicy, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, ManagerLadderRepository, PlayerRepository, PracticeSessionRepository } from '../ports/ports';

export interface RunPracticeSessionCommand {
  playerId: PlayerId;
  managerId: ManagerId;
}

export interface RunPracticeSessionResult {
  experience: number;
  fatigue: number;
  ladderPoints: number;
}

/**
 * Runs one practice session for a rostered player (P8a) — the no-form,
 * no-ranking training outlet that makes the fatigue/form constraint
 * systems tolerable. A manager sends a player to practice instead of
 * entering a tournament: the player gains development experience (funds
 * training), pays a SMALL fatigue cost, and the manager banks a bit of
 * ladder standing — with deliberately NO form change and NO
 * `ranking_ledger` entry (a practice isn't a result).
 *
 * Once per player per game day: the `PracticeSessionRepository` records
 * the (player, day) marker, so a second practice the same day is refused.
 * This is what stops "practice forever" from being an infinite XP tap —
 * the day clock is the throttle, exactly as it paces matches.
 */
export class RunPracticeSessionUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly worlds: GameWorldRepository,
    private readonly worldId: WorldId,
    private readonly practices: PracticeSessionRepository,
    private readonly managerLadder: ManagerLadderRepository,
    private readonly policy: PracticePolicy,
  ) {}

  async execute(command: RunPracticeSessionCommand): Promise<RunPracticeSessionResult> {
    const player = await this.players.findById(command.playerId);
    if (!player) throw new Error(`Player ${command.playerId} not found`);
    if (player.managerId !== command.managerId) {
      throw new Error(`Player ${command.playerId} is not on manager ${command.managerId}'s roster`);
    }
    if (player.isRetired()) {
      throw new Error(`Retired player ${command.playerId} cannot practice`);
    }

    const world = await this.worlds.findById(this.worldId);
    const today = world?.currentGameDay ?? { season: 1, week: 1, day: 1 };

    if (await this.practices.recordedOn(command.playerId, today)) {
      throw new Error(`Player ${command.playerId} has already practiced today`);
    }

    const experience = this.policy.practiceExperience();
    const fatigue = this.policy.practiceFatigue();
    const ladderPoints = this.policy.ladderPoints();

    player.gainExperience(experience);
    player.applyMatchFatigue(fatigue);
    await this.players.save(player);

    await this.managerLadder.credit(command.managerId, ladderPoints);
    await this.practices.record(command.playerId, today);

    return { experience, fatigue, ladderPoints };
  }
}
