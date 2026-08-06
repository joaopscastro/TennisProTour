import { describe, expect, it } from 'vitest';
import {
  Coach,
  ManagerId,
  Player,
  PlayerAttributes,
  PlayerId,
  Skill,
  StandardCoachConversionPolicy,
  SurfaceAffinities,
} from '@tennis-manager/domain';
import { CoachRepository, EventPublisherPort, IdGeneratorPort, ManagerXpRepository, PlayerRepository } from '../ports/ports';
import { COACH_CAP_PER_MANAGER, ConvertPlayerToCoachUseCase } from './ConvertPlayerToCoachUseCase';

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

class InMemoryCoachRepository implements CoachRepository {
  private readonly store: Coach[] = [];

  async findByManager(managerId: ManagerId): Promise<Coach[]> {
    return this.store.filter((c) => c.managerId === managerId);
  }

  async save(coach: Coach): Promise<void> {
    this.store.push(coach);
  }
}

class InMemoryManagerXpRepository implements ManagerXpRepository {
  private readonly balances = new Map<ManagerId, number>();

  async balanceFor(managerId: ManagerId): Promise<number> {
    return this.balances.get(managerId) ?? 0;
  }

  async credit(managerId: ManagerId, amount: number): Promise<void> {
    this.balances.set(managerId, (this.balances.get(managerId) ?? 0) + amount);
  }

  async spendXpIfSufficient(managerId: ManagerId, amount: number): Promise<boolean> {
    const balance = this.balances.get(managerId) ?? 0;
    if (balance < amount) return false;
    this.balances.set(managerId, balance - amount);
    return true;
  }
}

class SequentialIdGenerator implements IdGeneratorPort {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    return `coach-${this.counter}`;
  }
}

class RecordingEventPublisher implements EventPublisherPort {
  readonly published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    this.published.push(...events);
  }
}

function attributesAt(value: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(value), forehand: Skill.of(value), backhand: Skill.of(value), volley: Skill.of(value) },
    physical: { speed: Skill.of(value), stamina: Skill.of(value), strength: Skill.of(value) },
    mental: { consistency: Skill.of(value), clutch: Skill.of(value) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

function makePlayer(id: PlayerId, managerId: ManagerId, ageInWeeks = 25 * 52, overall = 60): Player {
  return Player.hire(id, id, ageInWeeks, attributesAt(overall), managerId);
}

const AMPLE_XP = 100_000;

function makeUseCase(
  players: InMemoryPlayerRepository,
  coaches: InMemoryCoachRepository,
  managerXp: InMemoryManagerXpRepository,
  events: EventPublisherPort = new RecordingEventPublisher(),
): ConvertPlayerToCoachUseCase {
  return new ConvertPlayerToCoachUseCase(
    players,
    coaches,
    managerXp,
    new StandardCoachConversionPolicy(),
    new SequentialIdGenerator(),
    events,
  );
}

describe('ConvertPlayerToCoachUseCase', () => {
  it('converts a rostered player: spends XP, frees the roster slot, and creates a Coach', async () => {
    const players = new InMemoryPlayerRepository();
    const coaches = new InMemoryCoachRepository();
    const managerXp = new InMemoryManagerXpRepository();
    const events = new RecordingEventPublisher();
    const managerId = ManagerId('m1');
    await players.save(makePlayer(PlayerId('p1'), managerId));
    await managerXp.credit(managerId, AMPLE_XP);

    const useCase = makeUseCase(players, coaches, managerXp, events);
    const coach = await useCase.execute({ playerId: PlayerId('p1'), managerId });

    expect(coach.managerId).toBe(managerId);
    expect(coach.sourcePlayerId).toBe(PlayerId('p1'));
    expect(coach.coachRating).toBeGreaterThan(0);

    // The player left the roster entirely — free agent now.
    const player = await players.findById(PlayerId('p1'));
    expect(player!.managerId).toBeNull();
    expect(await players.findByManager(managerId)).toHaveLength(0);

    // XP was actually spent.
    expect(await managerXp.balanceFor(managerId)).toBeLessThan(AMPLE_XP);

    // Persisted and event published.
    expect(await coaches.findByManager(managerId)).toHaveLength(1);
    expect(events.published.some((e) => e.type === 'PlayerConvertedToCoach')).toBe(true);
  });

  it('produces a higher coachRating (and charges more XP) for an older, more able player', async () => {
    const players = new InMemoryPlayerRepository();
    const coaches = new InMemoryCoachRepository();
    const managerXp = new InMemoryManagerXpRepository();
    const managerId = ManagerId('m1');
    await players.save(makePlayer(PlayerId('weak'), managerId, 20 * 52, 30));
    await players.save(makePlayer(PlayerId('strong'), managerId, 32 * 52, 85));
    await managerXp.credit(managerId, AMPLE_XP);

    const useCase = makeUseCase(players, coaches, managerXp);
    const weakCoach = await useCase.execute({ playerId: PlayerId('weak'), managerId });
    const balanceAfterWeak = await managerXp.balanceFor(managerId);

    // A second coach can't be created (cap=1) without releasing the
    // first, so measure the strong conversion's cost via a second
    // manager instead — isolates pricing from the cap entirely.
    const managerId2 = ManagerId('m2');
    await players.save(makePlayer(PlayerId('strong2'), managerId2, 32 * 52, 85));
    await managerXp.credit(managerId2, AMPLE_XP);
    const strongCoach = await useCase.execute({ playerId: PlayerId('strong2'), managerId: managerId2 });
    const balanceAfterStrong = await managerXp.balanceFor(managerId2);

    expect(strongCoach.coachRating).toBeGreaterThan(weakCoach.coachRating);
    expect(AMPLE_XP - balanceAfterStrong).toBeGreaterThan(AMPLE_XP - balanceAfterWeak);
  });

  it('rejects converting a player the manager does not own', async () => {
    const players = new InMemoryPlayerRepository();
    const coaches = new InMemoryCoachRepository();
    const managerXp = new InMemoryManagerXpRepository();
    await players.save(makePlayer(PlayerId('p1'), ManagerId('owner')));
    await managerXp.credit(ManagerId('someone-else'), AMPLE_XP);

    const useCase = makeUseCase(players, coaches, managerXp);
    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId: ManagerId('someone-else') })).rejects.toThrow(
      /not on manager/,
    );

    // Nothing happened: player still rostered, no XP spent, no coach created.
    expect((await players.findById(PlayerId('p1')))!.managerId).toBe(ManagerId('owner'));
    expect(await managerXp.balanceFor(ManagerId('someone-else'))).toBe(AMPLE_XP);
    expect(await coaches.findByManager(ManagerId('someone-else'))).toHaveLength(0);
  });

  it('rejects converting a nonexistent player', async () => {
    const players = new InMemoryPlayerRepository();
    const coaches = new InMemoryCoachRepository();
    const managerXp = new InMemoryManagerXpRepository();
    const useCase = makeUseCase(players, coaches, managerXp);

    await expect(useCase.execute({ playerId: PlayerId('nope'), managerId: ManagerId('m1') })).rejects.toThrow(/not found/);
  });

  it('rejects a conversion when the manager cannot afford it, spending nothing and leaving the player rostered', async () => {
    const players = new InMemoryPlayerRepository();
    const coaches = new InMemoryCoachRepository();
    const managerXp = new InMemoryManagerXpRepository();
    const managerId = ManagerId('m1');
    await players.save(makePlayer(PlayerId('p1'), managerId));
    await managerXp.credit(managerId, 1); // nowhere near enough

    const useCase = makeUseCase(players, coaches, managerXp);
    await expect(useCase.execute({ playerId: PlayerId('p1'), managerId })).rejects.toThrow(/insufficient XP/);

    expect((await players.findById(PlayerId('p1')))!.managerId).toBe(managerId);
    expect(await managerXp.balanceFor(managerId)).toBe(1);
    expect(await coaches.findByManager(managerId)).toHaveLength(0);
  });

  it(`rejects a conversion once the manager already has ${COACH_CAP_PER_MANAGER} coach(es) (free-tier cap)`, async () => {
    const players = new InMemoryPlayerRepository();
    const coaches = new InMemoryCoachRepository();
    const managerXp = new InMemoryManagerXpRepository();
    const managerId = ManagerId('m1');
    await players.save(makePlayer(PlayerId('p1'), managerId));
    await players.save(makePlayer(PlayerId('p2'), managerId));
    await managerXp.credit(managerId, AMPLE_XP);

    const useCase = makeUseCase(players, coaches, managerXp);
    await useCase.execute({ playerId: PlayerId('p1'), managerId });

    await expect(useCase.execute({ playerId: PlayerId('p2'), managerId })).rejects.toThrow(/already has/);

    // The 2nd player was never touched — still rostered.
    expect((await players.findById(PlayerId('p2')))!.managerId).toBe(managerId);
    expect(await coaches.findByManager(managerId)).toHaveLength(1);
  });
});
