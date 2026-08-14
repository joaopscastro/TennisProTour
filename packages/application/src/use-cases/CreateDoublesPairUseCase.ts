import { DoublesPair, ManagerId, PairId, PlayerId } from '@tennis-manager/domain';
import { DoublesPairRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';

export interface CreateDoublesPairCommand {
  /** The initiating player — the one whose manager is creating the
   * pair. Must be on `managerId`'s roster. */
  playerA: PlayerId;
  /** The partner. If this player belongs to `managerId` too, the pair
   * is formed immediately (`active`); otherwise it is a cross-manager
   * invitation (`pending`) that the partner's manager must accept. */
  playerB: PlayerId;
  /** The manager creating the pair — must own `playerA`. */
  managerId: ManagerId;
}

/**
 * Forms a doubles partnership (P7a,
 * docs/doubles-and-special-formats-plan.md) — the user-facing "create a
 * pair from my board" and "invite another manager's player" action in
 * one use case. The two ways a pair comes to exist map directly onto
 * whether the two players share a manager:
 *
 * - **Same-manager**: both players are on `managerId`'s roster → the
 *   pair is `active` the moment it's created (no acceptance step).
 * - **Cross-manager**: `playerB` belongs to a DIFFERENT manager → the
 *   pair is `pending`, and it's `playerB`'s manager who accepts it (via
 *   AcceptDoublesPairUseCase).
 *
 * Free agents and fill-only players are excluded entirely: a managerless
 * player has no manager to form a pair with or to accept an invite, so
 * `playerB` must have a manager (any manager). A player may be in at
 * most ONE active pair or pending invite at a time — enforced here
 * against the pairs this use case can already see, and left as a
 * check-then-act (not an atomic DB guard) for the same reason the
 * roster-cap check in ConvertPlayerToCoachUseCase is: the window is
 * small enough that the existing codebase has accepted this shape
 * before, and a genuinely race-safe version would need a conditional
 * insert the way TalentClaimPort does for signings. Disclosed, not
 * silently glossed over.
 */
export class CreateDoublesPairUseCase {
  constructor(
    private readonly players: PlayerRepository,
    private readonly pairs: DoublesPairRepository,
    private readonly idGenerator: IdGeneratorPort,
  ) {}

  async execute(command: CreateDoublesPairCommand): Promise<DoublesPair> {
    const [playerA, playerB] = await Promise.all([
      this.players.findById(command.playerA),
      this.players.findById(command.playerB),
    ]);
    if (!playerA) throw new Error(`Player ${command.playerA} not found`);
    if (!playerB) throw new Error(`Player ${command.playerB} not found`);
    if (playerA.managerId !== command.managerId) {
      throw new Error(`Player ${command.playerA} is not on manager ${command.managerId}'s roster`);
    }
    if (playerB.managerId === null) {
      throw new Error(`Player ${command.playerB} is a free agent and cannot be in a doubles pair`);
    }

    const [pairsForA, pairsForB] = await Promise.all([
      this.pairs.findByPlayer(command.playerA),
      this.pairs.findByPlayer(command.playerB),
    ]);
    if (pairsForA.some((p) => !p.isDissolved)) {
      throw new Error(`Player ${command.playerA} is already in a doubles pair or pending invitation`);
    }
    if (pairsForB.some((p) => !p.isDissolved)) {
      throw new Error(`Player ${command.playerB} is already in a doubles pair or pending invitation`);
    }

    const sameManager = playerA.managerId === playerB.managerId;
    const pair = sameManager
      ? DoublesPair.activate(PairId(this.idGenerator.generate()), command.playerA, command.playerB)
      : DoublesPair.propose(PairId(this.idGenerator.generate()), command.playerA, command.playerB);

    await this.pairs.save(pair);
    return pair;
  }
}
