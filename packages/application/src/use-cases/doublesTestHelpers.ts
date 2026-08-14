import { DoublesPair, ManagerId, PairId, Player, PlayerAttributes, PlayerId, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { DoublesPairRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';

/** Shared in-memory fakes for the doubles-pair use-case tests (P7a). A
 * deliberate small deviation from the "one in-memory repo per test
 * file" duplication the older use-case tests use — the three pair use
 * cases share the exact same two fakes, so hoisting them here avoids
 * three near-identical copies. Not a *.test.ts file, so vitest doesn't
 * treat it as a suite. */

export class InMemoryPlayerRepository implements PlayerRepository {
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
}

export class InMemoryDoublesPairRepository implements DoublesPairRepository {
  private readonly store = new Map<PairId, DoublesPair>();

  async findById(id: PairId): Promise<DoublesPair | null> {
    return this.store.get(id) ?? null;
  }

  async findByPlayer(playerId: PlayerId): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => p.involves(playerId));
  }

  async findByPlayers(playerIds: PlayerId[]): Promise<DoublesPair[]> {
    const set = new Set(playerIds);
    return [...this.store.values()].filter((p) => set.has(p.playerA) || set.has(p.playerB));
  }

  async findActive(): Promise<DoublesPair[]> {
    return [...this.store.values()].filter((p) => p.isActive);
  }

  async save(pair: DoublesPair): Promise<void> {
    this.store.set(pair.id, pair);
  }
}

export class SequentialIdGenerator implements IdGeneratorPort {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    return `pair-${this.counter}`;
  }
}

/** A hired player on `managerId`'s roster, or a free agent when
 * `managerId` is null (hire with a temp manager, then release). */
export function makePlayer(id: PlayerId, managerId: ManagerId | null): Player {
  const attributes = new PlayerAttributes({
    technical: { serve: Skill.of(50), forehand: Skill.of(50), backhand: Skill.of(50), volley: Skill.of(50) },
    physical: { speed: Skill.of(50), stamina: Skill.of(50), strength: Skill.of(50) },
    mental: { consistency: Skill.of(50), clutch: Skill.of(50) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
  const player = Player.hire(id, id, 25 * 52, attributes, managerId ?? ManagerId('temporary'));
  if (managerId === null) player.releaseFromManager();
  return player;
}
