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
  juniorEligibilityForAge,
} from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';

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

/** Senior (17-37yo): enough to pad several senior draws (a week's senior
 * slate is ~2 futures + 2 challengers + a tour ≈ 192 entrants). U16
 * (14-16yo) and U14 (12-14yo) are smaller because the junior ladder's
 * draws are smaller and the weekly talent-pool refresh already produces
 * 14-16yo. Deliberately distinct from GENESIS_AGE_RANGE: this is the
 * recurring floor, not the one-time cold-start seed. */
export const FILL_ONLY_FLOORS: ReadonlyArray<FillerBandFloor> = [
  { band: 'senior', minimum: 200, ageRange: { minWeeks: 17 * 52, maxWeeks: 38 * 52 - 1 } },
  { band: 'u16', minimum: 40, ageRange: { minWeeks: 14 * 52 + 1, maxWeeks: 16 * 52 } },
  { band: 'u14', minimum: 10, ageRange: { minWeeks: 12 * 52, maxWeeks: 14 * 52 } },
];

export interface EnsureFillOnlyPopulationCommand {
  worldId: WorldId;
}

export interface EnsureFillOnlyPopulationResult {
  generated: number;
}

/**
 * The recurring SAFE GUARD that keeps a world's draw-filler population
 * from ever running dry: every weekly rollover, this tops up each age
 * band's fill-only free agents to a floor, generating the shortfall
 * across the full age ladder.
 *
 * Why it must exist: a world's fill-only population only ever SHRINKS —
 * players are claimed (fillOnly flips off), or retire — and the weekly
 * talent-pool refresh only ever generates 14-16-year-old prospects, so
 * senior-age fillers (and, to a lesser degree, U14) deplete with nothing
 * refilling them. The genesis seed (GenesisSeedFillOnlyPlayersUseCase) is
 * one-time; without this guard, a live world eventually reaches a state
 * where a senior tournament's empty draw has no age-eligible filler to
 * pad it — exactly the "blank tournaments" failure a production world
 * must never see.
 *
 * Idempotent by construction: it only ever generates the shortfall up to
 * each floor, so a re-fire is a no-op. Reuses PlayerGenerationPolicy
 * completely as-is (age range is already a parameter), exactly like the
 * genesis seed.
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
  ) {}

  async execute(command: EnsureFillOnlyPopulationCommand): Promise<EnsureFillOnlyPopulationResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);

    const fillOnly = (await this.players.findAll()).filter((p) => p.fillOnly);
    const counts: Record<RankingBand, number> = { senior: 0, u16: 0, u14: 0 };
    for (const player of fillOnly) counts[juniorEligibilityForAge(player.ageInWeeks)] += 1;

    let generated = 0;
    for (const floor of FILL_ONLY_FLOORS) {
      const shortfall = floor.minimum - counts[floor.band];
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
