import { DoublesPair, ManagerId, PairId } from '@tennis-manager/domain';
import { DoublesPairRepository, PlayerRepository } from '../ports/ports';

export interface AcceptDoublesPairCommand {
  pairId: PairId;
  /** The manager accepting the invitation — must own the NON-initiating
   * player (`playerB`), since it's their player being invited. */
  managerId: ManagerId;
}

/**
 * The invitee's side of a cross-manager partnership (P7a): accepts a
 * `pending` pair, flipping it to `active`. `playerB` is by construction
 * the invited player (see CreateDoublesPairUseCase — `playerA` is
 * always the initiating side), so acceptance is authorized by ownership
 * of `playerB`. A same-manager pair never passes through here (it's
 * created `active` already), and an already-active/dissolved pair is
 * rejected rather than silently no-op'd — the only valid transition is
 * the one this use case exists to perform.
 */
export class AcceptDoublesPairUseCase {
  constructor(
    private readonly pairs: DoublesPairRepository,
    private readonly players: PlayerRepository,
  ) {}

  async execute(command: AcceptDoublesPairCommand): Promise<DoublesPair> {
    const pair = await this.pairs.findById(command.pairId);
    if (!pair) throw new Error(`Doubles pair ${command.pairId} not found`);
    if (!pair.isPending) {
      throw new Error(`Doubles pair ${command.pairId} is ${pair.status}, not awaiting acceptance`);
    }

    const playerB = await this.players.findById(pair.playerB);
    if (!playerB) throw new Error(`Player ${pair.playerB} not found`);
    if (playerB.managerId !== command.managerId) {
      throw new Error(`Manager ${command.managerId} cannot accept this invitation — it belongs to ${pair.playerB}'s manager`);
    }

    // Re-verify the one-active-pair-per-player invariant AT ACCEPTANCE.
    // CreateDoublesPairUseCase's own check is check-then-act, so between
    // this invite being created (pending) and now, the initiator
    // (playerA) could have formed or accepted ANOTHER pair — accepting
    // blindly would then leave a player in two active pairs. Only
    // NON-dissolved pairs count, and this pending pair is one of them, so
    // it's excluded by id. (Narrows the window but doesn't fully close
    // it — two accepts racing each other can still both pass; a fully
    // atomic form would need a conditional status UPDATE plus a DB
    // constraint, deliberately not added here without verifying it's safe
    // for every existing write path.)
    const [pairsForA, pairsForB] = await Promise.all([
      this.pairs.findByPlayer(pair.playerA),
      this.pairs.findByPlayer(pair.playerB),
    ]);
    const conflicts = [...pairsForA, ...pairsForB].filter((p) => p.id !== pair.id && !p.isDissolved);
    if (conflicts.length > 0) {
      throw new Error(
        `Cannot accept — a player in this pair is already in another doubles pair or pending invitation`,
      );
    }

    pair.accept();
    await this.pairs.save(pair);
    return pair;
  }
}
