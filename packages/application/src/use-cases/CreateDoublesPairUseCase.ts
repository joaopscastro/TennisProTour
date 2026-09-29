import { DoublesPair, ManagerId, PairId, PlayerId } from '@tennis-manager/domain';
import { DoublesPairRepository, IdGeneratorPort, PlayerRepository } from '../ports/ports';

export interface CreateDoublesPairCommand {
  /** One side of the pair — must be on `managerId`'s roster. */
  playerA: PlayerId;
  /** The partner. MUST also belong to `managerId` (see this class's doc
   * comment for the real cross-manager bug that made this a hard rule) —
   * a pair request never silently turns into an invitation that sits
   * pending forever. */
  playerB: PlayerId;
  /** The manager creating the pair — must own BOTH players. */
  managerId: ManagerId;
}

/**
 * Forms a doubles partnership (P7a,
 * docs/doubles-and-special-formats-plan.md) — the user-facing "pair two
 * of my players" action. **Both players must be on the caller's
 * roster**: the pair is `active` the moment it is created (no acceptance
 * step).
 *
 * **Historical note, deliberately kept: this used to support a
 * cross-manager invitation** — `playerB` on another manager's roster
 * created a `pending` pair the other manager could accept later. That
 * was removed after a real incident in the season-4 agent run: a manager
 * requested a pair toward ANOTHER manager's player, got a `201`, and the
 * pending invite sat unanswered forever (there is no notification/
 * acceptance loop a real manager actually uses) — meanwhile it occupied
 * the one-pair slot of BOTH players, so the requester could not form
 * their real, own-roster pair until they found and dissolved the bogus
 * one. A pair request must therefore require BOTH players on the
 * caller's roster, and be refused with a clear message otherwise.
 * `DoublesPair.propose`/`AcceptDoublesPairUseCase` still exist and still
 * work for genuinely PENDING rows (historical data, and the dissolve
 * path), but NOTHING in this codebase creates a new pending pair any
 * more.
 *
 * Free agents, fill-only players and RETIRED players are excluded
 * entirely: a managerless player has no manager to pair with, and a
 * retired player can never play again. A player may be in at most ONE
 * active pair or pending invite at a time — enforced here against the
 * pairs this use case can already see, and left as a check-then-act (not
 * an atomic DB guard) for the same reason the roster-cap check in
 * ConvertPlayerToCoachUseCase is: the window is small enough that the
 * existing codebase has accepted this shape before, and a genuinely
 * race-safe version would need a conditional insert the way
 * TalentClaimPort does for signings. Disclosed, not silently glossed
 * over.
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
    // The live bug this rule closes: a request toward ANOTHER manager's
    // player used to return 201 and create a pending invite that could
    // sit unanswered forever, blocking the requester's own pairing.
    if (playerB.managerId !== command.managerId) {
      throw new Error(
        `Player ${command.playerB} is not on manager ${command.managerId}'s roster — ` +
          `a pair must be formed between two of your own players`,
      );
    }
    if (playerA.isRetired()) {
      throw new Error(`Retired player ${command.playerA} cannot be in a doubles pair`);
    }
    if (playerB.isRetired()) {
      throw new Error(`Retired player ${command.playerB} cannot be in a doubles pair`);
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

    const pair = DoublesPair.activate(PairId(this.idGenerator.generate()), command.playerA, command.playerB);

    await this.pairs.save(pair);
    return pair;
  }
}
