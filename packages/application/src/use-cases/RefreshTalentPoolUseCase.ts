import { AgingPolicy, PlayerGenerationPolicy, RandomSource, StandardAgingPolicy, TalentPoolCandidate, TalentPoolCandidateId, WorldId } from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository, TalentPoolCandidateRepository } from '../ports/ports';
import { convertToFillOnlyPlayer } from './fillOnlyConversion';
import { TALENT_POOL_AGE_RANGE } from './talentPoolAgeRange';

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
 * candidate). This loop's read-then-write DOES have a narrow, real race
 * against a concurrent claim, though: if a manager successfully claims
 * a candidate in the window between this loop's `findAvailable()` read
 * and its `save()` write for that same candidate, this loop's stale
 * in-memory `markExpired()` would overwrite the claim back to
 * 'expired' — a pre-existing gap (not introduced by the fill-only
 * conversion below), narrow in practice (it only matters if a claim
 * lands inside this loop's single-tick execution window), and a good
 * candidate for a follow-up pass that makes expiry a single atomic
 * conditional UPDATE the same way claimIfAvailable() already is,
 * rather than something fixed here as a side effect of unrelated work.
 *
 * **Fill-only conversion** (docs/tournament-fill-system.md): expiry no
 * longer just marks a candidate 'expired' and leaves it inert. The
 * underlying player is real and should keep developing even after
 * dropping out of the actively-claimable Scouting list — so the exact
 * moment a candidate expires, it becomes a real, permanent, fill-only
 * Player (Player.generateFillOnly, managerId: null), reusing the
 * candidate's own id as the new player's id (same "this IS that player
 * from here on" convention ClaimTalentPoolCandidateUseCase already
 * uses for an actual claim). There is no path back from fillOnly to
 * claimable — matches TalentPoolCandidate.markExpired()'s own
 * no-un-expire invariant, and is the deliberate, simpler default
 * docs/tournament-fill-system.md's open question flags (avoids
 * extending the Scouting UI to browse a years-deep historical roster).
 * The TalentPoolCandidate row itself is NEVER deleted here (or
 * anywhere — see TalentPoolCandidateRepository's doc comment): it
 * stays as a permanent 'expired' record, now alongside the fillOnly
 * Player it was converted into, not instead of it.
 */
export class RefreshTalentPoolUseCase {
  constructor(
    private readonly candidates: TalentPoolCandidateRepository,
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
    const currentWeek = world.currentWeek;

    const available = await this.candidates.findAvailable();
    let expired = 0;
    for (const candidate of available) {
      if (candidate.isExpiredAsOf(currentWeek)) {
        candidate.markExpired();
        await this.candidates.save(candidate);

        const fillOnlyPlayer = convertToFillOnlyPlayer(candidate, this.agingPolicy);
        await this.players.save(fillOnlyPlayer);
        await this.events.publish(fillOnlyPlayer.pullDomainEvents());

        expired += 1;
      }
    }

    for (let i = 0; i < this.batchSize; i++) {
      const generated = this.generationPolicy.generate(this.random, TALENT_POOL_AGE_RANGE);
      const candidate = TalentPoolCandidate.generate(TalentPoolCandidateId(this.ids.generate()), generated, currentWeek);
      await this.candidates.save(candidate);
    }

    return { generated: this.batchSize, expired };
  }
}
