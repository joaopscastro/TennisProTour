import {
  AgeRange,
  AgingPolicy,
  Player,
  PlayerGenerationPolicy,
  PlayerId,
  RandomSource,
  RankingBand,
  StandardAgingPolicy,
  WorldId,
  addWeeks,
  juniorEligibilityForAge,
} from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository, TournamentRepository } from '../ports/ports';

/** One age-band floor the guard maintains: keep at least `minimum`
 * fill-only free agents in this band, generating any shortfall within
 * `ageRange` (which MUST map into that band via juniorEligibilityForAge).
 * PLACEHOLDER floors/ranges — illustrative, tuned with the rest of the
 * fill system (see docs/tournament-fill-system.md). */
export interface FillerBandFloor {
  band: RankingBand;
  minimum: number;
  ageRange: AgeRange;
}

/** Senior (18-37yo): enough to pad several senior draws (a week's senior
 * slate is ~2 futures + 2 challengers + a tour ≈ 192 entrants). U18
 * (16-18yo), U16 (14-16yo), and U14 (12-14yo) are smaller because the
 * junior ladder's draws are smaller and the weekly talent-pool refresh
 * already produces 12-16yo. Deliberately distinct from
 * GENESIS_AGE_RANGE: this is the recurring floor, not the one-time
 * cold-start seed. Each band's ageRange is generated from an age that
 * ALWAYS resolves to that band under `juniorEligibilityForAge` no
 * matter when in the season it's generated (a filler's
 * `seasonAgeAnchorWeeks` starts equal to its generated `ageInWeeks` —
 * see Player.seasonAgeAnchorWeeks' doc comment — so this only needs to
 * hold at generation time, not forever).
 *
 * WHY THIS IS A FLOOR, NOT THE TARGET. The weekly-commitment exclusion
 * means a filler can pad only ONE tournament per week, so the pool must
 * cover a whole week's slot DEMAND, not just "a couple of draws".
 * Derived from the schedule policies
 * (StandardSenior/StandardJuniorTournamentSchedulePolicy) and the
 * qualifying/wild-card reserved-slot rules:
 *   - Senior, non-major week: futures 2x32 + challenger 2x(27 main + 16
 *     qualifying) + tour 1x(54 + 32) = 236; a major week adds 238 -> 474.
 *   - Junior, per band: j30 3x16 + j60 2x16 + j100 32 + j200 32(every 2)
 *     + j300 64(every 4) + j500 64(every 8) = 272 on the peak
 *     every-8-week week (152 average). Across the three bands that is
 *     816 peak.
 *   - So TOTAL peak weekly demand = 236 + 816 = 1052 (1290 on the rare
 *     week a major and the junior peak coincide).
 * The floors sum to 290 (they are the cold-start safety net), and the
 * DEMAND-AWARE second pass below now tops the pool up to
 * `demand × FILL_DEMAND_HEADROOM_FACTOR` for the week just generated —
 * this replaces the earlier "KNOWN GAP, DELIBERATELY LEFT OPEN"
 * behaviour where the static floors were the whole target and
 * later-processed draws in a full week started short (the 3-season soak
 * saw started `tour` 64-draws with 4 entrants, and
 * `free_of_week39/44/48/50/52 = 0`). The floors stay in place for the
 * world's first ticks and as a belt-and-braces minimum. */
export const FILL_ONLY_FLOORS: ReadonlyArray<FillerBandFloor> = [
  // minWeeks is 18*52 + 1, NOT 17*52 — the senior range must start
  // strictly ABOVE the U18 band's own ceiling (18*52). Before the U18
  // band existed this could safely start at 17*52 (senior eligibility
  // began at 16*52+1 back then), but now any age in (16*52, 18*52]
  // resolves to 'u18' under juniorEligibilityForAge, not 'senior' — a
  // range overlapping that would silently under-count the senior floor
  // (some "senior" fillers would land in the u18 bucket instead) and
  // over-count u18's, a real bug caught by this file's own test suite
  // when the U18 band was added.
  { band: 'senior', minimum: 200, ageRange: { minWeeks: 18 * 52 + 1, maxWeeks: 38 * 52 - 1 } },
  { band: 'u18', minimum: 40, ageRange: { minWeeks: 16 * 52 + 1, maxWeeks: 18 * 52 } },
  { band: 'u16', minimum: 40, ageRange: { minWeeks: 14 * 52 + 1, maxWeeks: 16 * 52 } },
  { band: 'u14', minimum: 10, ageRange: { minWeeks: 12 * 52, maxWeeks: 14 * 52 } },
];

/**
 * How much headroom over one week's measured fill demand the demand-aware
 * pass keeps in the pool. The demand computation counts the slots that
 * WILL need padding if a draw stays empty (`mainDrawCapacity` +
 * `qualifyingDrawSize` per open draw scheduled for the week just
 * generated), but some fillers are still committed to earlier weeks'
 * draws when the next week's draws seed, so the pool must exceed the raw
 * number. PLACEHOLDER, tuned with the rest of the fill system — same
 * flagged-constant discipline as the floors and every economy constant.
 */
export const FILL_DEMAND_HEADROOM_FACTOR = 1.3;

export interface EnsureFillOnlyPopulationCommand {
  worldId: WorldId;
}

export interface EnsureFillOnlyPopulationResult {
  generated: number;
}

/**
 * The recurring SAFE GUARD that keeps a world's draw-filler population
 * from ever running dry: every weekly rollover, this tops up each age
 * band's fill-only free agents to whatever is higher — its safety floor
 * (FILL_ONLY_FLOORS) or the actual fill DEMAND of the week that was just
 * generated, times FILL_DEMAND_HEADROOM_FACTOR — generating the
 * shortfall across the full age ladder.
 *
 * The demand pass is why this can now keep a full weekly slate seedable:
 * the handler runs the content generators BEFORE this guard
 * (apps/worker/src/jobs/handlers.ts), so the week-NEXT open draws exist
 * and their padding requirement is readable (`mainDrawCapacity` +
 * `qualifyingDrawSize` per draw, summed per band). The static floors
 * alone (290 total vs ~1052 peak demand) meant later-processed draws in
 * a full week could never fill — verified live as
 * `free_of_week39/44/48/50/52 = 0`.
 *
 * Why it must exist: a world's fill-only population only ever SHRINKS —
 * players are claimed (fillOnly flips off), or retire — and the weekly
 * talent-pool refresh only ever generates 12-16-year-old prospects, so
 * senior-age fillers deplete with nothing refilling them. The genesis
 * seed (GenesisSeedFillOnlyPlayersUseCase) is one-time; without this
 * guard, a live world eventually reaches a state where a senior
 * tournament's empty draw has no age-eligible filler to pad it — exactly
 * the "blank tournaments" failure a production world must never see.
 *
 * Idempotent by construction: it only ever generates the shortfall up to
 * the per-band target, so a re-fire is a no-op. Reuses
 * PlayerGenerationPolicy completely as-is (age range is already a
 * parameter), exactly like the genesis seed.
 */
export class EnsureFillOnlyPopulationUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly players: PlayerRepository,
    private readonly events: EventPublisherPort,
    private readonly generationPolicy: PlayerGenerationPolicy,
    private readonly random: RandomSource,
    private readonly ids: IdGeneratorPort,
    private readonly agingPolicy: AgingPolicy = new StandardAgingPolicy(),
    /** The open-draw read the demand pass needs. Optional and LAST for
     * test compatibility (a fake/legacy construction without it keeps
     * the floor-only behavior); the composition root always passes it. */
    private readonly tournaments?: TournamentRepository,
  ) {}

  async execute(command: EnsureFillOnlyPopulationCommand): Promise<EnsureFillOnlyPopulationResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);

    // Retired players are never live draw fillers — without this
    // exclusion they keep counting toward the per-band floor forever
    // (nothing deletes a retired player), so the count over-reports a
    // supply that can no longer pad a draw and the real shortfall is
    // silently under-generated until the live pool runs dry.
    const fillOnly = (await this.players.findAll()).filter((p) => p.fillOnly && !p.isRetired());
    // Only AVAILABLE fillers count toward the target. A player still
    // committed to an unfinished draw — last week's 14-day major, an
    // event mid-play, or a match simulated seconds ago and still inside
    // its staggered reveal window — cannot pad anything this tick (the
    // fill helpers exclude exactly this set, see
    // TournamentRepository.findUnfinishedCommitmentPlayerIds), so
    // counting them toward the target would report it satisfied while
    // the actual fill comes up short. The pilot run that found this: a
    // 273-strong u14 pool whose members were all mid-draw at the
    // rollover generated zero fresh u14 fillers and 11 due draws
    // starved. The set is optional (in-memory fakes omit it); absent,
    // every fill-only player counts as before.
    const committedIds =
      this.tournaments?.findUnfinishedCommitmentPlayerIds
        ? new Set(await this.tournaments.findUnfinishedCommitmentPlayerIds())
        : null;
    const counts: Record<RankingBand, number> = { senior: 0, u18: 0, u16: 0, u14: 0 };
    // Band-count by the SAME eligibility age the actual consumer
    // (StartDueTournamentsUseCase.fillSlots' isAgeEligibleForTournamentBand
    // check) uses — seasonAgeAnchorWeeks, never raw ageInWeeks — so this
    // floor never under/over-counts relative to who's actually usable as
    // a filler for a given band's draw right now.
    for (const player of fillOnly) {
      if (committedIds?.has(player.id)) continue;
      counts[juniorEligibilityForAge(player.seasonAgeAnchorWeeks)] += 1;
    }

    // The week's actual fill demand, per band. The generators open NEXT
    // week's slate (GenerateSenior/JuniorTournamentsUseCase both use
    // addWeeks(currentWeek, 1)) and run earlier in the same tick, so the
    // draws this guard is preparing for are exactly the open ones
    // scheduled for that week. Per draw, the slots that will need padding
    // are the direct-acceptance places (`mainDrawCapacity`, which already
    // excludes the reserved qualifier/wild-card places) plus the whole
    // qualifying field (`qualifyingDrawSize`) — both via the existing
    // Tournament accessors, never a re-derived copy of the capacity
    // rules. No demand read (a fake without a tournament repository)
    // leaves the demand at zero and the pass reduces to the floors.
    const demand: Record<RankingBand, number> = { senior: 0, u18: 0, u16: 0, u14: 0 };
    if (this.tournaments) {
      const targetWeek = addWeeks(world.currentWeek, 1);
      for (const tournament of await this.tournaments.findOpenForRegistration()) {
        if (
          tournament.weekScheduled.season !== targetWeek.season ||
          tournament.weekScheduled.week !== targetWeek.week
        ) {
          continue;
        }
        const band: RankingBand = tournament.ageBand ?? 'senior';
        demand[band] += tournament.mainDrawCapacity + tournament.qualifyingDrawSize;
      }
    }

    let generated = 0;
    for (const floor of FILL_ONLY_FLOORS) {
      const demandTarget = Math.ceil(demand[floor.band] * FILL_DEMAND_HEADROOM_FACTOR);
      const target = Math.max(floor.minimum, demandTarget);
      const shortfall = target - counts[floor.band];
      for (let i = 0; i < shortfall; i++) {
        const g = this.generationPolicy.generate(this.random, floor.ageRange);
        const player = Player.generateFillOnly(
          PlayerId(this.ids.generate()),
          g.name,
          g.ageInWeeks,
          this.agingPolicy.stageForAge(g.ageInWeeks),
          g.attributes,
          g.nationality,
          g.potentialCeiling,
          g.physicalCeilings,
          g.talent,
        );
        await this.players.save(player);
        await this.events.publish(player.pullDomainEvents());
        generated += 1;
      }
    }

    return { generated };
  }
}
