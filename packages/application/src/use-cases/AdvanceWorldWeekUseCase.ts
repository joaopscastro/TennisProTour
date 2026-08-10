import {
  bestResultsCapFor,
  computeGraduationCarryover,
  juniorEligibilityForAge,
  matchesRankingBand,
  ManagerId,
  PlayerAgingService,
  RankingCalculationService,
  resolveTrainingFocusForWeek,
  TrainingPolicy,
  weakestTrainableAttribute,
  WorldId,
} from '@tennis-manager/domain';
import {
  BillingPort,
  CoachRepository,
  EventPublisherPort,
  GameWorldRepository,
  PlayerRepository,
  RankingLedgerRepository,
  TrainingScheduleRepository,
} from '../ports/ports';

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
 * The Manager Pro tradeoff (CLAUDE.md principle #1) is applied HERE:
 * players managed by a Pro subscriber age through the accelerated
 * service (steeper weekly decline via AcceleratedDeclinePolicy) —
 * the built-in cost of the 4-slot roster. Free-managed players and
 * free agents use the standard service. Pro status is looked up once
 * per manager per tick, not once per player.
 *
 * Same tick also applies each player's EFFECTIVE training focus for
 * THIS week, resolved fresh from their training schedule (see
 * TrainingSchedule.ts's resolveTrainingFocusForWeek and
 * SetTrainingScheduleUseCase) rather than read off a single mutable
 * field — same cadence as aging: a manager commits to a focus once
 * (for the current week or any future one), and it applies
 * automatically every week until a later explicit entry overrides it.
 * A week with no applicable entry at all gets no training delta that
 * week; nothing is invented on their behalf. Idempotency for this,
 * like aging, comes for free from the tickKey guard above — a re-run
 * of an already-applied tick returns before this loop runs at all. The
 * "no retroactive change" guarantee this relies on lives in
 * resolveTrainingFocusForWeek itself (a pure function of entries with
 * effectiveFrom <= the CURRENT week, which SetTrainingScheduleUseCase
 * never lets be in the past) — this use case just calls it once per
 * player, per tick, against world.currentWeek AFTER it's already been
 * advanced to the week this tick is actually applying.
 *
 * A manager's coach (if any — COACH_CAP_PER_MANAGER is 1 today, see
 * ConvertPlayerToCoachUseCase) is looked up here too and its
 * coachRating passed into applyTraining, same "looked up once per
 * manager per tick, not once per player" caching pattern as Pro status
 * above (coachRatingByManager mirrors proStatusByManager exactly). A
 * free agent (managerId null) has no manager to have a coach, so
 * always trains uncoached.
 *
 * **fillOnly players are the one exception to "no focus set means no
 * training delta."** They have no manager to ever set a training
 * schedule entry in the first place (see Player.fillOnly's doc comment
 * and docs/tournament-fill-system.md item 4), so instead of resolving
 * one from the schedule (which stays permanently empty for them), this
 * loop computes a fresh focus every tick via weakestTrainableAttribute
 * — "train whichever eligible attribute is weakest," the simple
 * automatic default the doc calls for. A RELEASED player (also
 * managerId: null, but fillOnly stays false) is NOT affected by this
 * branch at all and keeps exactly its prior schedule-resolution
 * behavior — fillOnly, not managerId, is what distinguishes the two.
 *
 * Honest limitation, deliberate for now: the per-player saves and the
 * final world save are not one atomic transaction, so a crash mid-run
 * can age some players and leave the tick unrecorded (a rerun would
 * re-age those). The guard protects against the routine failure mode
 * (scheduler double-fire); crash-consistency needs a unit-of-work
 * port and can be added without changing this use case's callers.
 *
 * Same tick is also where a junior graduation carryover gets recorded
 * (see domain/ranking/GraduationCarryover.ts): a player ages by
 * exactly one week per tick, and the U14/U16 boundaries are 104 weeks
 * apart, so comparing `juniorEligibilityForAge(ageInWeeks)` before and
 * after `agingService.advance()` is sufficient to detect a crossing —
 * a single tick can never skip past a boundary unnoticed. This only
 * ever RECORDS a dormant bonus on the player (their current total in
 * the band they're leaving, times GRADUATION_CARRYOVER_FRACTION) — it
 * never writes a ranking-ledger entry itself; see that module's doc
 * comment for why (a ranking must be earned, never granted from aging
 * alone). Consuming the bonus happens later, in SimulateMatchUseCase,
 * the only place real ranking-ledger entries are ever written.
 */
export class AdvanceWorldWeekUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly players: PlayerRepository,
    private readonly billing: BillingPort,
    private readonly standardAging: PlayerAgingService,
    private readonly proAging: PlayerAgingService,
    private readonly events: EventPublisherPort,
    private readonly trainingPolicy: TrainingPolicy,
    private readonly coaches: CoachRepository,
    private readonly rankingLedger: RankingLedgerRepository,
    private readonly trainingSchedule: TrainingScheduleRepository,
  ) {}

  async execute(command: AdvanceWorldWeekCommand): Promise<AdvanceWorldWeekResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);

    if (!world.advanceWeek(command.tickKey)) {
      return { advanced: false, playersAged: 0 };
    }

    const proStatusByManager = new Map<ManagerId, boolean>();
    const isProManaged = async (managerId: ManagerId | null): Promise<boolean> => {
      if (managerId === null) return false;
      const cached = proStatusByManager.get(managerId);
      if (cached !== undefined) return cached;
      const isPro = await this.billing.isProSubscriber(managerId);
      proStatusByManager.set(managerId, isPro);
      return isPro;
    };

    const coachRatingByManager = new Map<ManagerId, number | null>();
    const coachRatingFor = async (managerId: ManagerId | null): Promise<number | null> => {
      if (managerId === null) return null;
      const cached = coachRatingByManager.get(managerId);
      if (cached !== undefined) return cached;
      const [coach] = await this.coaches.findByManager(managerId);
      const rating = coach?.coachRating ?? null;
      coachRatingByManager.set(managerId, rating);
      return rating;
    };

    const allPlayers = await this.players.findAll();
    for (const player of allPlayers) {
      const agingService = (await isProManaged(player.managerId)) ? this.proAging : this.standardAging;
      const bandBeforeAging = juniorEligibilityForAge(player.ageInWeeks);
      agingService.advance(player);
      const bandAfterAging = juniorEligibilityForAge(player.ageInWeeks);
      if (bandBeforeAging !== bandAfterAging) {
        const oldBandEntries = (await this.rankingLedger.findByPlayer(player.id)).filter((entry) =>
          matchesRankingBand(entry.ageBand, bandBeforeAging),
        );
        const oldBandCalculator = new RankingCalculationService(bestResultsCapFor(bandBeforeAging));
        const oldBandTotal = oldBandCalculator.calculateTotal(oldBandEntries, world.currentWeek);
        player.setDormantCarryoverBonus(computeGraduationCarryover(bandAfterAging, oldBandTotal));
      }
      // Aging can tip a player into retirement this same tick;
      // applyTraining rejects retired players, so re-check after aging
      // rather than trusting a resolved focus was computed against a
      // live player.
      if (player.fillOnly) {
        // No manager, no schedule to resolve — see this class's doc
        // comment. A fillOnly player that aged into retirement this
        // same tick just stops training, same as anyone else.
        if (!player.isRetired()) {
          const focus = { kind: 'attribute' as const, attribute: weakestTrainableAttribute(player.attributes) };
          player.applyTraining(focus, this.trainingPolicy, null);
        }
      } else if (!player.isRetired()) {
        // world.currentWeek here is the week THIS tick just advanced
        // TO (advanceWeek() above already mutated it) — resolving
        // against that, not the week we came from, is what makes "set
        // a focus starting this week" actually apply to this same
        // tick's training, exactly like aging already applies to this
        // same tick's age.
        const scheduleEntries = await this.trainingSchedule.findByPlayer(player.id);
        const focus = resolveTrainingFocusForWeek(scheduleEntries, world.currentWeek);
        if (focus) {
          const coachRating = await coachRatingFor(player.managerId);
          player.applyTraining(focus, this.trainingPolicy, coachRating);
        }
      }
      await this.players.save(player);
      await this.events.publish(player.pullDomainEvents());
    }

    await this.worlds.save(world);
    return { advanced: true, playersAged: allPlayers.length };
  }
}
