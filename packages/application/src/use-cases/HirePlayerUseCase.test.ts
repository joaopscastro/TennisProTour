import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { DomainEvent } from '@tennis-manager/domain';
import { EventPublisherPort, PlayerRepository } from '../ports/ports';
import { HirePlayerUseCase } from './HirePlayerUseCase';

class InMemoryPlayerRepository implements PlayerRepository {
  private readonly store = new Map<PlayerId, Player>();

  async findById(id: PlayerId): Promise<Player | null> {
    return this.store.get(id) ?? null;
  }

  async findByManager(managerId: ManagerId): Promise<Player[]> {
    return [...this.store.values()].filter((p) => p.managerId === managerId);
  }

  async save(player: Player): Promise<void> {
    this.store.set(player.id, player);
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: DomainEvent[] = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...(events as DomainEvent[]));
  }
}

describe('HirePlayerUseCase', () => {
  it('hires a player when the roster has room', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('m1');
    const useCase = new HirePlayerUseCase(players, events, async () => 3);

    await useCase.execute({
      playerId: PlayerId('p1'),
      name: 'João Silva',
      managerId,
      startingAgeInWeeks: 18 * 52,
    });

    const roster = await players.findByManager(managerId);
    expect(roster).toHaveLength(1);
    expect(roster[0].id).toBe('p1');
    expect(roster[0].stage).toBe('youth');
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({ type: 'PlayerHired' });
  });

  it('throws when the roster is already at the cap', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('m1');
    const useCase = new HirePlayerUseCase(players, events, async () => 1);

    await useCase.execute({
      playerId: PlayerId('p1'),
      name: 'First Player',
      managerId,
      startingAgeInWeeks: 18 * 52,
    });

    await expect(
      useCase.execute({
        playerId: PlayerId('p2'),
        name: 'Second Player',
        managerId,
        startingAgeInWeeks: 18 * 52,
      }),
    ).rejects.toThrow();
  });

  it('starts every hired player with the same baseline attributes', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const useCase = new HirePlayerUseCase(players, events, async () => 5);

    await useCase.execute({
      playerId: PlayerId('p1'),
      name: 'João Silva',
      managerId: ManagerId('m1'),
      startingAgeInWeeks: 18 * 52,
    });

    const hired = await players.findById(PlayerId('p1'));
    expect(hired!.attributes.technical.serve.value).toBe(30);
    expect(hired!.attributes.physical.speed.value).toBe(30);
    expect(hired!.attributes.mental.clutch.value).toBe(30);
    expect(hired!.attributes.surfaceAffinities.get('clay')).toBe(20);
  });
});
