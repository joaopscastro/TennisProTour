import { ManagerId } from '@tennis-manager/domain';
import { ManagerAccountRepository, PlayerRepository } from '../ports/ports';
import { ReleasePlayerUseCase } from './ReleasePlayerUseCase';

export interface DeleteManagerAccountCommand {
  managerId: ManagerId;
}

/**
 * Self-service account deletion (`docs/security-and-identity.md`'s
 * production checklist — the one genuine code gap in that doc, everything
 * else there is config/ops). Mirrors exactly how `ReleasePlayerUseCase`
 * already treats a single player when a manager relationship ends: a
 * released player's `managerId` goes null but the player itself, and all
 * its game history (ranking ledger, titles, peaks), stays fully intact —
 * because that history belongs to the *Player* aggregate, not the
 * manager. Account deletion does the same for every player the manager
 * currently owns, one at a time through the real `ReleasePlayerUseCase`
 * (so the doubles-pair-dissolution cascade it already implements runs
 * for each of them too — not reimplemented here), then anonymizes the
 * `ManagerAccount` row itself.
 *
 * The account row is anonymized, not deleted outright: `manager_ladder`
 * and other tables reference the manager id by foreign key, and per the
 * doc's own phrasing ("preserving only the minimum historical game
 * records required by the rules"), those references need to stay valid,
 * just stripped of anything personally identifying. `authSubject` and
 * `publicHandle` are overwritten with values derived from the manager's
 * own id (already unique, so the result is guaranteed unique too) rather
 * than left as the real Clerk subject/handle; `status: 'deleted'` blocks
 * `EnsureManagerAccountUseCase` from ever re-authenticating this account
 * (same `status !== 'active'` guard that already blocks a suspended one).
 */
export class DeleteManagerAccountUseCase {
  constructor(
    private readonly managers: ManagerAccountRepository,
    private readonly players: PlayerRepository,
    private readonly releasePlayer: ReleasePlayerUseCase,
  ) {}

  async execute(command: DeleteManagerAccountCommand): Promise<void> {
    const account = await this.managers.findById(command.managerId);
    if (!account) {
      throw new Error(`Manager ${command.managerId} not found`);
    }

    const roster = await this.players.findByManager(command.managerId);
    for (const player of roster) {
      await this.releasePlayer.execute({ playerId: player.id });
    }

    await this.managers.save({
      ...account,
      authSubject: `deleted:${account.id}`,
      displayName: 'Deleted manager',
      publicHandle: `deleted-${String(account.id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`,
      status: 'deleted',
    });
  }
}
