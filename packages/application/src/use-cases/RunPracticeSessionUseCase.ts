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
 *
 * **The ladder half is additionally capped PER WEEK** (season-4 balance
 * fix): the first `PracticePolicy.ladderSessionsPerWeek()` sessions a
 * player practises in a game week bank ladder points; later sessions
 * that week still grant development XP and cost fatigue but bank no
 * ladder. Measured before the cap: up to 105 ladder/week/player for a
 * day-and-a-half of clicks, fatigue-negative overall at the current
 * recovery, and invisible in the digest — three consecutive agent
 * seasons called it "exploit-shaped, not a choice". With the cap it is
 * a bounded, legible choice (see PracticePolicy's doc comment).
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

    // Claim today's practice slot ATOMICALLY (a conditional insert) BEFORE
    // awarding anything. A plain read-then-write would let two concurrent
    // requests both see "not yet practiced" and both award XP/fatigue/
    // ladder — the double-click double-spend this closes.
    if (!(await this.practices.tryRecord(command.playerId, today))) {
      throw new Error(`Player ${command.playerId} has already practiced today`);
    }

    // The weekly sessions count INCLUDES the just-recorded session, so
    // this session's 0-based index in the week is count - 1.
    const sessionsBeforeThisOne = Math.max(0, (await this.practices.countInWeek(command.playerId, today)) - 1);
    const experience = this.policy.practiceExperience();
    const fatigue = this.policy.practiceFatigue();
    const ladderPoints = this.policy.ladderPointsForSession(sessionsBeforeThisOne);

    player.gainExperience(experience);
    player.applyMatchFatigue(fatigue);
    await this.players.save(player);

    if (ladderPoints > 0) await this.managerLadder.credit(command.managerId, ladderPoints);

    return { experience, fatigue, ladderPoints };
  }
}
