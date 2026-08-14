import { DoublesPair, ManagerId, PairId } from '@tennis-manager/domain';
import { DoublesPairRepository, PlayerRepository } from '../ports/ports';

export interface DissolveDoublesPairCommand {
  pairId: PairId;
  /** The manager ending the pair — must own one of the two players
   * (either side may dissolve; a partnership is a two-way street and
   * nobody is trapped in it). */
  managerId: ManagerId;
}

/**
 * Ends a doubles partnership (P7a) — one use case for both "decline a
 * pending invite" and "break up an active pair", since the domain
 * transition is the same in both cases (`dissolve`). Authorized by
 * ownership of EITHER player: the invitee declining their own pending
 * invite and the initiator dissolving an active pair both land here.
 * Idempotent on an already-dissolved pair, so the release cascade in
 * ReleasePlayerUseCase can call it without a separate "is it still
 * active" check.
 */
export class DissolveDoublesPairUseCase {
  constructor(
    private readonly pairs: DoublesPairRepository,
    private readonly players: PlayerRepository,
  ) {}

  async execute(command: DissolveDoublesPairCommand): Promise<DoublesPair> {
    const pair = await this.pairs.findById(command.pairId);
    if (!pair) throw new Error(`Doubles pair ${command.pairId} not found`);
    if (pair.isDissolved) return pair;

    const [playerA, playerB] = await Promise.all([
      this.players.findById(pair.playerA),
      this.players.findById(pair.playerB),
    ]);
    const ownsA = playerA?.managerId === command.managerId;
    const ownsB = playerB?.managerId === command.managerId;
    if (!ownsA && !ownsB) {
      throw new Error(`Manager ${command.managerId} does not own either player of pair ${command.pairId}`);
    }

    pair.dissolve();
    await this.pairs.save(pair);
    return pair;
  }
}
