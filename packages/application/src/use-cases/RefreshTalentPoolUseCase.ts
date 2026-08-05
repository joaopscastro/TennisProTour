import { PlayerGenerationPolicy, RandomSource, TalentPoolCandidate, TalentPoolCandidateId, WorldId } from '@tennis-manager/domain';
import { GameWorldRepository, IdGeneratorPort, TalentPoolCandidateRepository } from '../ports/ports';

/** How many new candidates enter the pool each weekly refresh. A
 * balance/tuning constant, same status as StandardRankingPointsTable's
 * point values — illustrative, not final. */
export const TALENT_POOL_BATCH_SIZE = 5;

export interface RefreshTalentPoolCommand {
  worldId: WorldId;
}

export interface RefreshTalentPoolResult {
  generated: number;
  expired: number;
}

/**
 * The weekly talent-pool refresh: expire whatever's gone stale, then
 * top up with a fresh batch. Run from the same worker handler as
 * AdvanceWorldWeekUseCase, gated on that use case's own `advanced`
 * result rather than carrying its own idempotency-guard state — a
 * tick that didn't actually advance the world clock (a duplicate
 * scheduler fire) shouldn't refresh the pool either, and reusing
 * GameWorld's existing tickKey guard means this use case doesn't need
 * to invent a second one (see apps/worker/src/jobs/handlers.ts).
 *
 * Expiry is a plain read-then-write loop, NOT an atomic conditional
 * update like ClaimTalentPoolCandidateUseCase's claim path — that's a
 * deliberate difference, not an oversight: only claiming has a real
 * concurrent-writer problem (two managers racing for the same
 * candidate). Nothing else ever writes to a candidate's status
 * concurrently with this sweep, so there's no race to guard against
 * here, and a simple loop keeps this use case readable.
 */
export class RefreshTalentPoolUseCase {
  constructor(
    private readonly candidates: TalentPoolCandidateRepository,
    private readonly worlds: GameWorldRepository,
    private readonly generationPolicy: PlayerGenerationPolicy,
    private readonly random: RandomSource,
    private readonly ids: IdGeneratorPort,
    private readonly batchSize: number = TALENT_POOL_BATCH_SIZE,
  ) {}

  async execute(command: RefreshTalentPoolCommand): Promise<RefreshTalentPoolResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const currentWeek = world.currentWeek;

    const available = await this.candidates.findAvailable();
    let expired = 0;
    for (const candidate of available) {
      if (candidate.isExpiredAsOf(currentWeek)) {
        candidate.markExpired();
        await this.candidates.save(candidate);
        expired += 1;
      }
    }

    for (let i = 0; i < this.batchSize; i++) {
      const generated = this.generationPolicy.generate(this.random);
      const candidate = TalentPoolCandidate.generate(TalentPoolCandidateId(this.ids.generate()), generated, currentWeek);
      await this.candidates.save(candidate);
    }

    return { generated: this.batchSize, expired };
  }
}
