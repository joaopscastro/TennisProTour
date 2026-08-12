import { AgingPolicy, Player, PlayerGenerationPolicy, PlayerId, RandomSource, StandardAgingPolicy, WorldId } from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';

/** Default population size for a genesis seed — see this class's doc
 * comment for the reasoning (roughly a dozen players per age-year
 * across the full 14-37yo span, enough for every senior tier and both
 * junior bands to find ranking-appropriate fillers immediately). A
 * tuning constant, same status as TALENT_POOL_BATCH_SIZE — illustrative,
 * not final; overridable per call via the command's `population` field. */
export const GENESIS_POPULATION = 300;

/** 14 to (just under) 38 years — StandardAgingPolicy's full non-retired
 * span (youth <20, prime 20-30, decline 30-38, retired 38+). Retired
 * ages are deliberately excluded: a retired filler could never actually
 * be entered into a tournament (the same "no retired participant" rule
 * every hire/claim path already assumes), so generating one would be
 * dead weight from the moment it's created. */
export const GENESIS_AGE_RANGE = { minWeeks: 14 * 52, maxWeeks: 38 * 52 - 1 };

export interface GenesisSeedFillOnlyPlayersCommand {
  worldId: WorldId;
  /** Defaults to GENESIS_POPULATION — overridable for tests/tuning
   * without touching the constant every other caller relies on. */
  population?: number;
}

export interface GenesisSeedFillOnlyPlayersResult {
  generated: number;
}

/**
 * One-time genesis seed (docs/tournament-fill-system.md item 3): a
 * brand-new world starts with ZERO fill-only free agents, and the
 * normal weekly talent-pool pipeline only ever generates 14-16-year-old
 * candidates that take years of simulated time to age into every band
 * a tournament might need a filler from. Without this, a senior-tier
 * tournament (or an older junior band) simply wouldn't have a single
 * ranking-appropriate filler available for a long time after a world
 * launches.
 *
 * Run exactly once per world, at creation, from
 * apps/api/src/scripts/genesisSeedFillOnlyPlayers.ts — NOT wired into
 * the weekly tick or any other recurring job (contrast
 * RefreshTalentPoolUseCase, which runs every tick this world advances).
 * Nothing here guards against being run twice against the same world;
 * that's a deliberate match for this codebase's existing "one-shot
 * script, run by operator discipline, not automatically enforced"
 * convention (see seed.ts's own "reruns fail loudly on duplicate ids"
 * note — this use case doesn't even fail loudly, since every generated
 * id is fresh from IdGeneratorPort, so running it twice just doubles
 * the population rather than erroring; operators are expected to run
 * it once per world by discipline).
 *
 * Generates real Player aggregates directly via Player.generateFillOnly
 * — genesis players never pass through TalentPoolCandidate/the
 * claimable Scouting list at all, unlike a normal weekly-refresh
 * candidate that only becomes fill-only after expiring. Reuses
 * PlayerGenerationPolicy completely as-is (age range is already a
 * parameter, not hardcoded) — a genesis player is otherwise generated
 * exactly like any talent-pool candidate, just across a much wider age
 * span (GENESIS_AGE_RANGE) than TALENT_POOL_AGE_RANGE allows.
 */
export class GenesisSeedFillOnlyPlayersUseCase {
  constructor(
    private readonly worlds: GameWorldRepository,
    private readonly players: PlayerRepository,
    private readonly events: EventPublisherPort,
    private readonly generationPolicy: PlayerGenerationPolicy,
    private readonly random: RandomSource,
    private readonly ids: IdGeneratorPort,
    private readonly agingPolicy: AgingPolicy = new StandardAgingPolicy(),
  ) {}

  async execute(command: GenesisSeedFillOnlyPlayersCommand): Promise<GenesisSeedFillOnlyPlayersResult> {
    const world = await this.worlds.findById(command.worldId);
    if (!world) throw new Error(`Game world ${command.worldId} not found`);
    const population = command.population ?? GENESIS_POPULATION;

    for (let i = 0; i < population; i++) {
      const generated = this.generationPolicy.generate(this.random, GENESIS_AGE_RANGE);
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

    return { generated: population };
  }
}
