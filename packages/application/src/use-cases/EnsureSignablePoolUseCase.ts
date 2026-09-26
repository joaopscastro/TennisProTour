import {
  AgingPolicy,
  Player,
  PlayerGenerationPolicy,
  PlayerId,
  RandomSource,
  StandardAgingPolicy,
  WorldId,
} from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';
import { FILL_ONLY_FLOORS } from './EnsureFillOnlyPopulationUseCase';

/**
 * The hard floor the acquisition loop maintains on SIGNABLE free agents —
 * "you can always sign someone", whatever else the world is doing.
 * PLACEHOLDER, tuned with the rest of the fill/economy system: large
 * enough that a manager always has a real choice, small enough that the
 * pool is not flooded with talent the scouting/scarcity premise would
 * rather keep rare.
 */
export const MIN_SIGNABLE_FREE_AGENTS = 25;

export interface EnsureSignablePoolCommand {
  worldId: WorldId;
}

export interface EnsureSignablePoolResult {
  /** Signable free agents BEFORE this run (the exact claim predicate). */
  signableBefore: number;
  /** Fresh free agents generated to reach the floor (0 on an ordinary
   * run where the pool already had enough). */
  generated: number;
}

/**
 * The repeatable ACQUISITION loop (D3): every weekly rollover, after the
 * week's placements are committed, make sure the world still contains at
 * least MIN_SIGNABLE_FREE_AGENTS free agents a manager can actually
 * sign RIGHT NOW.
 *
 * Why this is separate from EnsureFillOnlyPopulationUseCase: that guard
 * sizes the DRAW-FILLER population to the slate's demand, counting only
 * AVAILABLE (uncommitted) fillers, and its target is per-band demand —
 * on a saturated week it can generate a large batch that is immediately
 * committed to draws, leaving the signable pool empty all the same. This
 * guard asks the one question a new or returning manager asks — "can I
 * sign anyone?" — and answers it with the INVERSE population: free
 * agents with NO unfinished commitment, i.e. exactly the rows the atomic
 * claim's conditional UPDATE would accept. It counts with the same
 * predicate (`PlayerRepository.countSignableFreeAgents`, the SQL twin of
 * `noUnfinishedCommitment`) rather than an approximation, so the guard
 * can never believe the pool is fine while every claim refuses.
 *
 * Run from the SAME weekly handler as the other weekly systems, but
 * deliberately AFTER StartDueTournamentsUseCase (apps/worker/src/jobs/
 * handlers.ts): the week's placements (including filler commits) are
 * made first, so this guard measures — and tops up — what is left
 * signable afterwards. Running it before would let the placements
 * consume the very pool it just guaranteed.
 *
 * Idempotent by construction: it only ever generates the shortfall up to
 * the floor, so a re-fire (or a second call in the same tick) is a no-op.
 * New players are `Player.generateFillOnly` like every other generated
 * free agent, spread across the same per-band age ranges the filler floor
 * uses, so the pool stays age-varied (cheap teenagers through
 * established seniors) rather than all one band.
 */
export class EnsureSignablePoolUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly players: PlayerRepository,
    private readonly events: EventPublisherPort,
    private readonly generationPolicy: PlayerGenerationPolicy,
    private readonly random: RandomSource,
    private readonly ids: IdGeneratorPort,
    private readonly agingPolicy: AgingPolicy = new StandardAgingPolicy(),
    /** The floor and the per-band generation ranges. Injectable (last,
     * defaulting to the real constants) so a test can pin behavior
     * without generating the production count. */
    private readonly minimum: number = MIN_SIGNABLE_FREE_AGENTS,
  ) {}

  async execute(command: EnsureSignablePoolCommand): Promise<EnsureSignablePoolResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);

    // Absent on an in-memory fake that predates the method: treat the
    // pool as empty and generate the floor (the safe direction — a real
    // adapter always implements it).
    const signableBefore = this.players.countSignableFreeAgents ? await this.players.countSignableFreeAgents() : 0;
    const shortfall = Math.max(0, this.minimum - signableBefore);

    let generated = 0;
    for (let i = 0; i < shortfall; i++) {
      const band = FILL_ONLY_FLOORS[i % FILL_ONLY_FLOORS.length];
      const rolled = this.generationPolicy.generate(this.random, band.ageRange);
      const player = Player.generateFillOnly(
        PlayerId(this.ids.generate()),
        rolled.name,
        rolled.ageInWeeks,
        this.agingPolicy.stageForAge(rolled.ageInWeeks),
        rolled.attributes,
        rolled.nationality,
        rolled.potentialCeiling,
        rolled.physicalCeilings,
        rolled.talent,
      );
      await this.players.save(player);
      await this.events.publish(player.pullDomainEvents());
      generated += 1;
    }

    return { signableBefore, generated };
  }
}
