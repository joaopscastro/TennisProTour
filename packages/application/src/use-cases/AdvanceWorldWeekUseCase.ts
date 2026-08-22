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
  WEEKS_PER_SEASON,
  WorldId,
} from '@tennis-manager/domain';
import {
  ManagerLadderPolicy,
  PlayerDevelopmentPolicy,
} from '@tennis-manager/domain';
import {
  BillingPort,
  CoachRepository,
  EventPublisherPort,
  GameWorldRepository,
  ManagerLadderRepository,
  PlayerRepository,
  RankingLedgerRepository,
  TournamentRepository,
  TrainingScheduleRepository,
} from '../ports/ports';

export interface AdvanceWorldWeekCommand {
  worldId: WorldId;
  /** External idempotency key for this tick — e.g. the real-world ISO
   * week ("2026-W31") the scheduler fired for. The same key applied
   * twice is a no-op (see GameWorld.advanceWeek). */
  tickKey: string;
}

/** Fatigue recovered per DAY tick (every advanced day, mid-week and on
 * the weekly rollover alike) — the recovery half of the fatigue system
 * whose accrual lives in SimulateMatchUseCase (fatigueCostForMatch).
 * RR recovers 50/day on a ~0–500+ scale; scaled to our 0–100 fatigue
 * scale and the per-match accrual (BASE_MATCH_FATIGUE = 8), 5/day makes
 * a player who plays a match every day of a deep run slowly accumulate
 * fatigue, while idle days bleed it back off — the scheduling tension
 * that is the whole point. PLACEHOLDER, owned by the fatigue/form
 * tuning pass (docs/rocking-rackets-competitive-analysis.md §5). */
export const FATIGUE_RECOVERY_PER_DAY = 5;

/** Multiplicative form decay applied once per WEEKLY rollover (0.85 =
 * lose 15%/week). RR decays −8%/week in a faster-moving real-time
 * world; a steeper weekly step keeps form responsive at our lower match
 * volume. PLACEHOLDER, same tuning pass as above. */
export const FORM_WEEKLY_DECAY = 0.85;

export interface AdvanceWorldWeekResult {
  advanced: boolean;
  /** True exactly when this day tick rolled the clock over to a new
   * game week (day 7 -> 1). The weekly systems (aging, training,
   * graduation carryover) only run on such a tick; a mid-week day tick
   * advances the clock and paces tournaments but leaves the large
   * weekly balance untouched. See docs/day-tick-and-scheduling.md. */
  weekRolledOver: boolean;
  playersAged: number;
  /** True exactly when this tick's rollover was ALSO a season boundary
   * (week WEEKS_PER_SEASON -> 1) — the signal a worker handler uses to
   * fire the once-a-season PaySeasonBonusPoolUseCase, kept as a
   * SEPARATE use case (like ApplyObligatoryTournamentZerosUseCase)
   * rather than folded in here, since it needs a whole-ledger read this
   * class has no other reason to hold. Always false on a non-rollover
   * or mid-season rollover tick. */
  seasonRolledOver: boolean;
  /** The season that just CONCLUDED when seasonRolledOver is true (i.e.
   * endingWeek.season, the season whose points the bonus pool standings
   * should sum) — undefined otherwise. */
  concludedSeason?: number;
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
 * (see domain/ranking/GraduationCarryover.ts) — but ONLY on a SEASON
 * rollover, not every weekly one. Junior age-band eligibility is
 * anchored to `Player.seasonAgeAnchorWeeks` (the real ITF "age as of
 * January 1" rule — see that field's doc comment), which this use case
 * refreshes via `player.anchorSeasonAge()` exactly once a season,
 * immediately after that tick's aging. Since the anchor never changes
 * on an ordinary weekly rollover, comparing
 * `juniorEligibilityForAge(seasonAgeAnchorWeeks)` before and after that
 * refresh is sufficient to detect a crossing — a crossing simply cannot
 * happen on any other tick. This only ever RECORDS a dormant bonus on
 * the player (their current total in the band they're leaving, times
 * GRADUATION_CARRYOVER_FRACTION) — it never writes a ranking-ledger
 * entry itself; see that module's doc comment for why (a ranking must
 * be earned, never granted from aging alone). Consuming the bonus
 * happens later, in SimulateMatchUseCase, the only place real
 * ranking-ledger entries are ever written.
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
    private readonly managerLadder: ManagerLadderRepository,
    private readonly managerLadderPolicy: ManagerLadderPolicy,
    private readonly developmentPolicy: PlayerDevelopmentPolicy,
    private readonly tournaments: TournamentRepository,
  ) {}

  async execute(command: AdvanceWorldWeekCommand): Promise<AdvanceWorldWeekResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);

    // Captured BEFORE advanceDay() mutates it — this is the week that's
    // ENDING with this rollover, i.e. the week a manager had to actually
    // register someone in, for the inactivity-penalty check below.
    const endingWeek = world.currentWeek;

    // One tick = one game DAY now (see docs/day-tick-and-scheduling.md).
    // The clock advances (idempotency aside); the heavy weekly work
    // below runs ONLY when the day rolled over into a new week.
    const { advanced, weekRolledOver } = world.advanceDay(command.tickKey);
    if (!advanced) {
      return { advanced: false, weekRolledOver: false, playersAged: 0, seasonRolledOver: false };
    }

    if (!weekRolledOver) {
      // A mid-week day tick: the clock moved forward (persist it so
      // tournament pacing and the day countdown see the new day), and
      // fatigue recovers daily (rest days matter — see
      // FATIGUE_RECOVERY_PER_DAY). Aging/training/graduation are weekly
      // and must not fire today; form decays only on the weekly rollover
      // below, not mid-week.
      await this.recoverDailyFatigue();
      await this.worlds.save(world);
      return { advanced: true, weekRolledOver: false, playersAged: 0, seasonRolledOver: false };
    }

    // A season boundary is a rollover whose ENDING week was the last
    // week of the season — the same "capture before advanceDay mutates
    // it" endingWeek this class already computed above for the
    // inactivity-penalty check.
    const seasonRolledOver = endingWeek.week === WEEKS_PER_SEASON;

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
      // The weekly rollover is itself one day passing, so it recovers
      // that day's fatigue too (same amount every advanced day); form
      // decays once per week here (never mid-week).
      player.recoverFatigue(FATIGUE_RECOVERY_PER_DAY);
      player.decayForm(FORM_WEEKLY_DECAY);
      // Zero every player's SEASON prize money the moment a new season
      // starts — the same tick PaySeasonBonusPoolUseCase reads the
      // just-concluded season's standings from the ranking ledger (not
      // from this field, which is display-only), so ordering here vs.
      // that separate use case doesn't matter.
      if (seasonRolledOver) player.resetSeasonPrizeMoney();
      const agingService = (await isProManaged(player.managerId)) ? this.proAging : this.standardAging;
      // Junior-band eligibility is anchored to the player's age as of
      // the season's start (see Player.seasonAgeAnchorWeeks' doc
      // comment for the real ITF "age as of January 1" rule this
      // implements), NOT their literal current age — so the anchor
      // (and therefore a graduation crossing) can only ever change on
      // a SEASON rollover, never an ordinary weekly one within a
      // season. bandBeforeAging is read before anchorSeasonAge() below
      // touches anything.
      const bandBeforeAging = juniorEligibilityForAge(player.seasonAgeAnchorWeeks);
      agingService.advance(player);
      if (seasonRolledOver) {
        // Refresh the anchor to the just-aged age — this IS the real
        // "January 1" moment (week 1 of the new season) — before
        // reading the new band below.
        player.anchorSeasonAge();
      }
      const bandAfterAging = juniorEligibilityForAge(player.seasonAgeAnchorWeeks);
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
      // Weekly free player-development experience proportional to
      // talent (docs/rocking-rackets-competitive-analysis.md §1c) —
      // credited to EVERY player (managed, released, or fillOnly), since
      // talent is innate and develops the player regardless of who, if
      // anyone, owns them. A talent-0 legacy player earns nothing here
      // and so only develops from match XP, exactly as before P4. This
      // is the XP that funds this same tick's training below.
      player.gainExperience(this.developmentPolicy.weeklyTalentIncome(player.talent));
      if (player.fillOnly) {
        // No manager, no schedule to resolve — see this class's doc
        // comment. A fillOnly player that aged into retirement this
        // same tick just stops training, same as anyone else.
        if (!player.isRetired()) {
          const focus = { kind: 'attribute' as const, attribute: weakestTrainableAttribute(player.attributes) };
          player.applyTraining(focus, this.trainingPolicy, null, this.developmentPolicy);
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
          player.applyTraining(focus, this.trainingPolicy, coachRating, this.developmentPolicy);
        }
      }
      await this.players.save(player);
      await this.events.publish(player.pullDomainEvents());
    }

    // The decaying manager ladder erodes once per weekly rollover (never
    // mid-week) — a single whole-table multiply, cost independent of how
    // many managers played. This is the "come back tomorrow" pull: a
    // score you must keep earning against or watch slide (see
    // docs/rocking-rackets-competitive-analysis.md §1d).
    await this.managerLadder.decayAll(this.managerLadderPolicy.weeklyDecayFactor());

    // The EXTRA inactivity penalty (see ManagerLadderPolicy.inactivityPenaltyFactor's
    // doc comment): a manager whose WHOLE roster registered zero entries
    // (singles or doubles) anywhere during the week that just ended gets
    // hit with a second, harsher decay on top of the routine one above.
    // A manager with no active players at all owes nothing here — there
    // was nobody to forget to register.
    const playersByManager = new Map<ManagerId, typeof allPlayers>();
    for (const player of allPlayers) {
      if (player.managerId === null || player.isRetired()) continue;
      const roster = playersByManager.get(player.managerId) ?? [];
      roster.push(player);
      playersByManager.set(player.managerId, roster);
    }
    const inactiveManagerIds: ManagerId[] = [];
    for (const [managerId, roster] of playersByManager) {
      let active = false;
      for (const player of roster) {
        const [singles, doubles] = await Promise.all([
          this.tournaments.findByPlayerAndWeek(player.id, endingWeek),
          this.tournaments.findDoublesByPlayerAndWeek(player.id, endingWeek),
        ]);
        if (singles.length > 0 || doubles.length > 0) {
          active = true;
          break;
        }
      }
      if (!active) inactiveManagerIds.push(managerId);
    }
    await this.managerLadder.decayManagers(inactiveManagerIds, this.managerLadderPolicy.inactivityPenaltyFactor());

    await this.worlds.save(world);
    return {
      advanced: true,
      weekRolledOver: true,
      playersAged: allPlayers.length,
      seasonRolledOver,
      concludedSeason: seasonRolledOver ? endingWeek.season : undefined,
    };
  }

  /** Recovers a day's worth of fatigue for every player carrying any,
   * on a mid-week day tick. Skips players already fully rested (fatigue
   * 0) so writes stay proportional to how many players are actually
   * tired, not the whole population, every day. Deliberately does NOT
   * touch form, aging, or training — those are weekly-rollover concerns
   * (see execute()). */
  private async recoverDailyFatigue(): Promise<void> {
    const allPlayers = await this.players.findAll();
    for (const player of allPlayers) {
      if (player.fatigue === 0) continue;
      player.recoverFatigue(FATIGUE_RECOVERY_PER_DAY);
      await this.players.save(player);
    }
  }
}
