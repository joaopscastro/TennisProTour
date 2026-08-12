import { describe, expect, it } from 'vitest';
import {
  AgeRange,
  GameWorld,
  GeneratedPlayer,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerGenerationPolicy,
  PlayerId,
  RandomSource,
  Skill,
  SurfaceAffinities,
  WorldId,
} from '@tennis-manager/domain';
import { EventPublisherPort, GameWorldRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';
import { RefreshTalentPoolUseCase, TALENT_POOL_BATCH_SIZE } from './RefreshTalentPoolUseCase';

class InMemoryGameWorldRepository implements GameWorldRepository {
  private readonly store = new Map<WorldId, GameWorld>();

  async findById(id: WorldId): Promise<GameWorld | null> {
    return this.store.get(id) ?? null;
  }

  async save(world: GameWorld): Promise<void> {
    this.store.set(world.id, world);
  }
}

class InMemoryPlayerRepository implements PlayerRepository {
  private readonly store = new Map<PlayerId, Player>();

  async findById(id: PlayerId): Promise<Player | null> {
    return this.store.get(id) ?? null;
  }

  async findByManager(managerId: ManagerId): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === managerId);
  }

  async findAll(): Promise<Player[]> {
    return [...this.store.values()];
  }

  async findFreeAgents(): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === null && !p.isRetired());
  }

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }

  all(): Player[] {
    return [...this.store.values()];
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
  }
}

class SequentialIdGenerator implements IdGeneratorPort {
  private nextId = 0;

  generate(): string {
    this.nextId += 1;
    return `generated-${this.nextId}`;
  }
}

class FixedRandomSource implements RandomSource {
  next(): number {
    return 0;
  }
}

class DeterministicGenerationPolicy implements PlayerGenerationPolicy {
  readonly ageRanges: AgeRange[] = [];
  private generated = 0;

  generate(_random: RandomSource, ageRange: AgeRange): GeneratedPlayer {
    this.ageRanges.push(ageRange);
    this.generated += 1;
    return {
      name: `Prospect ${this.generated}`,
      nationality: 'PT',
      tier: 'common',
      ageInWeeks: 15 * 52,
      attributes: attributes(35 + this.generated),
      potentialCeiling: 70,
      potentialTier: 'promising',
      physicalCeilings: { speed: 75, stamina: 76, strength: 77 },
      talent: 60,
    };
  }
}

function attributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

async function setup(batchSize?: number) {
  const worlds = new InMemoryGameWorldRepository();
  const players = new InMemoryPlayerRepository();
  const events = new RecordingEventPublisher();
  const generationPolicy = new DeterministicGenerationPolicy();
  const worldId = WorldId('main');
  await worlds.save(GameWorld.create(worldId, { season: 1, week: 1 }));
  const useCase = new RefreshTalentPoolUseCase(worlds, generationPolicy, new FixedRandomSource(), new SequentialIdGenerator(), players, events, undefined, batchSize);
  return { worlds, players, events, generationPolicy, worldId, useCase };
}

describe('RefreshTalentPoolUseCase', () => {
  it('generates the default batch as fillOnly free-agent players', async () => {
    const { players, events, generationPolicy, worldId, useCase } = await setup();

    const result = await useCase.execute({ worldId });

    expect(result).toEqual({ generated: TALENT_POOL_BATCH_SIZE });
    expect(players.all()).toHaveLength(TALENT_POOL_BATCH_SIZE);
    expect(players.all().every((p) => p.managerId === null)).toBe(true);
    expect(players.all().every((p) => p.fillOnly)).toBe(true);
    expect(events.published).toHaveLength(TALENT_POOL_BATCH_SIZE);
    expect(events.published.every((e) => e.type === 'FillOnlyPlayerGenerated')).toBe(true);
    expect(generationPolicy.ageRanges).toHaveLength(TALENT_POOL_BATCH_SIZE);
  });

  it('honors a custom batch size', async () => {
    const { players, worldId, useCase } = await setup(2);

    const result = await useCase.execute({ worldId });

    expect(result).toEqual({ generated: 2 });
    expect(players.all()).toHaveLength(2);
    expect(players.all().map((p) => p.id)).toEqual(['generated-1', 'generated-2']);
  });

  it('only adds new players and never removes or expires existing ones', async () => {
    const { players, worldId, useCase } = await setup(1);
    const existing = Player.generateFillOnly(PlayerId('existing'), 'Existing Free Agent', 20 * 52, 'prime', attributes(50), 'BR', 80, {
      speed: 80,
      stamina: 80,
      strength: 80,
    });
    await players.save(existing);

    const result = await useCase.execute({ worldId });

    expect(result).toEqual({ generated: 1 });
    expect(await players.findById(PlayerId('existing'))).toBe(existing);
    expect(players.all().map((p) => p.id).sort()).toEqual(['existing', 'generated-1']);
  });

  it('throws when the target game world does not exist', async () => {
    const { useCase } = await setup();

    await expect(useCase.execute({ worldId: WorldId('missing') })).rejects.toThrow(/not found/);
  });
});