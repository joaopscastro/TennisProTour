import { describe, expect, it } from 'vitest';
import { ManagerId, PlayerId } from '@tennis-manager/domain';
import { Player } from '@tennis-manager/domain';
import { PlayerAttributes, Skill, SurfaceAffinities } from '@tennis-manager/domain';
import { ManagerAccount, ManagerAccountRepository } from '../ports/ports';
import { DeleteManagerAccountUseCase } from './DeleteManagerAccountUseCase';
import { ReleasePlayerUseCase } from './ReleasePlayerUseCase';
import { InMemoryDoublesPairRepository, InMemoryPlayerRepository } from './doublesTestHelpers';

class InMemoryManagerAccountRepository implements ManagerAccountRepository {
  private byId = new Map<string, ManagerAccount>();

  async findByAuthSubject(authSubject: string): Promise<ManagerAccount | null> {
    for (const account of this.byId.values()) {
      if (account.authSubject === authSubject) return account;
    }
    return null;
  }

  async findById(id: ManagerId): Promise<ManagerAccount | null> {
    return this.byId.get(id) ?? null;
  }

  async save(account: ManagerAccount): Promise<void> {
    this.byId.set(account.id, account);
  }
}

function startingAttributes(): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(30), forehand: Skill.of(30), backhand: Skill.of(30), volley: Skill.of(30) },
    physical: { speed: Skill.of(30), stamina: Skill.of(30), strength: Skill.of(30) },
    mental: { consistency: Skill.of(30), clutch: Skill.of(30) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

describe('DeleteManagerAccountUseCase', () => {
  it('releases every rostered player (keeping them, unowned) and anonymizes the manager row', async () => {
    const managers = new InMemoryManagerAccountRepository();
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();

    const account: ManagerAccount = {
      id: ManagerId('m1'),
      authSubject: 'clerk|real-subject-123',
      displayName: 'Real Name',
      publicHandle: 'manager-m1',
      status: 'active',
    };
    await managers.save(account);
    const p1 = Player.hire(PlayerId('p1'), 'João Silva', 18 * 52, startingAttributes(), ManagerId('m1'));
    const p2 = Player.hire(PlayerId('p2'), 'Maria Costa', 19 * 52, startingAttributes(), ManagerId('m1'));
    await players.save(p1);
    await players.save(p2);

    const useCase = new DeleteManagerAccountUseCase(managers, players, new ReleasePlayerUseCase(players, pairs));
    await useCase.execute({ managerId: ManagerId('m1') });

    // The players themselves survive, unowned — same guarantee
    // ReleasePlayerUseCase already gives a single released player. Their
    // full game history (ranking ledger, titles, peaks — not modeled by
    // this fake repo) belongs to the Player aggregate, not the manager,
    // so deleting the manager can never touch it.
    expect((await players.findById(PlayerId('p1')))!.managerId).toBeNull();
    expect((await players.findById(PlayerId('p2')))!.managerId).toBeNull();

    const deleted = await managers.findById(ManagerId('m1'));
    expect(deleted!.status).toBe('deleted');
    // Personally-identifying fields are overwritten...
    expect(deleted!.authSubject).not.toBe('clerk|real-subject-123');
    expect(deleted!.displayName).not.toBe('Real Name');
    // ...but the row itself, and its id, still exist — foreign keys
    // (manager_ladder, etc.) referencing this manager id stay valid.
    expect(deleted!.id).toBe(ManagerId('m1'));
  });

  it('throws when the manager does not exist', async () => {
    const managers = new InMemoryManagerAccountRepository();
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    const useCase = new DeleteManagerAccountUseCase(managers, players, new ReleasePlayerUseCase(players, pairs));

    await expect(useCase.execute({ managerId: ManagerId('ghost') })).rejects.toThrow(/not found/);
  });

  it('is a no-op on the roster for a manager with no players', async () => {
    const managers = new InMemoryManagerAccountRepository();
    const players = new InMemoryPlayerRepository();
    const pairs = new InMemoryDoublesPairRepository();
    await managers.save({ id: ManagerId('m2'), authSubject: 'sub-2', displayName: 'Empty Roster', publicHandle: 'manager-m2', status: 'active' });

    const useCase = new DeleteManagerAccountUseCase(managers, players, new ReleasePlayerUseCase(players, pairs));
    await useCase.execute({ managerId: ManagerId('m2') });

    expect((await managers.findById(ManagerId('m2')))!.status).toBe('deleted');
  });
});
