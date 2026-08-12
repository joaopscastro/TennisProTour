import { AgingPolicy, PlayerGenerationPolicy, PlayerId, RandomSource, StandardAgingPolicy, WorldId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';
import { TALENT_POOL_AGE_RANGE } from './talentPoolAgeRange';

/** How many new young free agents enter the world each weekly refresh. A
 * balance/tuning constant, same status as StandardRankingPointsTable's
 * point values — illustrative, not final. */
export const TALENT_POOL_BATCH_SIZE = 5;

export interface RefreshTalentPoolCommand {
  worldId: WorldId;
}

export interface RefreshTalentPoolResult {
  generated: number;
}

/**
 * The weekly talent influx: generate a fresh batch of new young free
 * agents entering the world. Run from the same worker handler as
 * AdvanceWorldWeekUseCase, gated on that use case's own `advanced`
 * result rather than carrying its own idempotency-guard state — a tick
 * that didn't actually advance the world clock (a duplicate scheduler
 * fire) shouldn't refresh the pool either, and reusing GameWorld's
 * existing tickKey guard means this use case doesn't need to invent a
 * second one (see apps/worker/src/jobs/handlers.ts).
 *
 * **No expiry, ever** (candidate/player unification — see docs/CLAUDE.md).
 * A generated prospect is a real, permanent Player from the moment it's
 * created: it lives in the world for its whole career, aging and (while
 * unowned) auto-training toward its weakest attribute every tick via
 * AdvanceWorldWeekUseCase, whether or not a manager ever signs it. It
 * never "expires" or vanishes from the pool — that was the old
 * TalentPoolCandidate model, which produced the nonsensical outcome of a
 * player winning a tournament and then ceasing to exist. Every free
 * agent stays signable until a manager signs it (transferring ownership
 * via ClaimTalentPoolCandidateUseCase) or it retires of old age like
 * anyone else. This use case therefore only ADDS to the world; it never
 * removes or mutates existing players.
 *
 * New free agents are generated as `fillOnly` players (Player.generateFillOnly)
 * so they auto-develop while unsigned; signing flips fillOnly off so the
 * player then trains from its new manager's schedule.
 */
export class RefreshTalentPoolUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly generationPolicy: PlayerGenerationPolicy,
    private readonly random: RandomSource,
    private readonly ids: IdGeneratorPort,
    private readonly players: PlayerRepository,
    private readonly events: EventPublisherPort,
    private readonly agingPolicy: AgingPolicy = new StandardAgingPolicy(),
    private readonly batchSize: number = TALENT_POOL_BATCH_SIZE,
  ) {}

  async execute(command: RefreshTalentPoolCommand): Promise<RefreshTalentPoolResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);

    for (let i = 0; i < this.batchSize; i++) {
      const generated = this.generationPolicy.generate(this.random, TALENT_POOL_AGE_RANGE);
      const stage = this.agingPolicy.stageForAge(generated.ageInWeeks);
      const player = Player.generateFillOnly(
        PlayerId(this.ids.generate()),
        generated.name,
        generated.ageInWeeks,
        stage,
        generated.attributes,
        generated.nationality,
        generated.potentialCeiling,
        generated.physicalCeilings,
        generated.talent,
      );
      await this.players.save(player);
      await this.events.publish(player.pullDomainEvents());
    }

    return { generated: this.batchSize };
  }
}
