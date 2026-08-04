import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { DomainEvent } from '@tennis-manager/domain';
import { BillingPort, EventPublisherPort, PlayerRepository } from '../ports/ports';
import { HirePlayerUseCase } from './HirePlayerUseCase';

class FakeBillingPort implements BillingPort {
  constructor(private readonly proManagers: Set<string> = new Set()) {}

  async isProSubscriber(managerId: ManagerId): Promise<boolean> {
    return this.proManagers.has(managerId);
  }

  async createProCheckoutSession(): Promise<{ url: string }> {
    return { url: 'https://checkout.test/session' };
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
    const useCase = new HirePlayerUseCase(players, events, new FakeBillingPort());

    await useCase.execute({
      playerId: PlayerId('p1'),
      name: 'João Silva',
      nationality: 'BR',
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

  it('caps a free manager at 2 players', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('m1');
    const useCase = new HirePlayerUseCase(players, events, new FakeBillingPort());

    for (let i = 1; i <= 2; i++) {
      await useCase.execute({
        playerId: PlayerId(`p${i}`),
        name: `Player ${i}`,
        nationality: 'BR',
        managerId,
        startingAgeInWeeks: 18 * 52,
      });
    }

    await expect(
      useCase.execute({
        playerId: PlayerId('p3'),
        name: 'One Too Many',
        nationality: 'BR',
        managerId,
        startingAgeInWeeks: 18 * 52,
      }),
    ).rejects.toThrow(/roster is full/);
  });

  it('caps a Pro manager at 4 players via BillingPort.isProSubscriber', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('pro-manager');
    const useCase = new HirePlayerUseCase(players, events, new FakeBillingPort(new Set(['pro-manager'])));

    for (let i = 1; i <= 4; i++) {
      await useCase.execute({
        playerId: PlayerId(`p${i}`),
        name: `Player ${i}`,
        nationality: 'BR',
        managerId,
        startingAgeInWeeks: 18 * 52,
      });
    }
    expect(await players.findByManager(managerId)).toHaveLength(4);

    await expect(
      useCase.execute({
        playerId: PlayerId('p5'),
        name: 'One Too Many',
        nationality: 'BR',
        managerId,
        startingAgeInWeeks: 18 * 52,
      }),
    ).rejects.toThrow(/roster is full/);
  });

  it('starts every hired player with the same baseline attributes', async () => {
    const players = new InMemoryPlayerRepository();
    const events = new RecordingEventPublisher();
    const useCase = new HirePlayerUseCase(players, events, new FakeBillingPort());

    await useCase.execute({
      playerId: PlayerId('p1'),
      name: 'João Silva',
      nationality: 'BR',
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
