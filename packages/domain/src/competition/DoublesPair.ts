import { PairId, PlayerId } from '../shared/ids';

/** The lifecycle of a doubles partnership (P7a,
 * docs/doubles-and-special-formats-plan.md): `pending` while the
 * non-initiating manager hasn't answered an invite, `active` once
 * playing, `dissolved` once ended (declined, or dissolved later). */
export type DoublesPairStatus = 'pending' | 'active' | 'dissolved';

export interface DoublesPairProps {
  id: PairId;
  /** The player whose manager created the pair — the "initiator" side.
   * For a cross-manager pair this is the side already committed; for a
   * same-manager pair it's just the first of the two. */
  playerA: PlayerId;
  /** The partner. For a cross-manager pair this is whose manager must
   * accept the invitation. */
  playerB: PlayerId;
  status: DoublesPairStatus;
  /** Pair chemistry (P7c) — how well these two have gelled, grown by
   * playing doubles matches together. Optional: absent = 0 (every
   * pre-P7c pair and test). 0-100. */
  chemistry?: number;
}

/**
 * Aggregate root for a doubles partnership (P7a + P7c). A small, pure
 * state machine — who the two players are, where the pair is in its
 * lifecycle, and how much chemistry they've built together. Chemistry is
 * the one mechanical thing a persistent partnership grants over a random
 * solo pairing: it grows from playing together and feeds a small sim
 * bonus (see StatisticalMatchSimulator.CHEMISTRY_BONUS_PER_POINT), which
 * is what makes "keep a steady partner" a real strategic choice rather
 * than pure flavor. The authorization questions — which manager may
 * create/accept/dissolve — are deliberately NOT answered here either:
 * they are use-case concerns (the aggregate references players only by
 * `PlayerId`, never by manager), so this stays the "cross-context by id
 * only" rule the whole codebase follows.
 *
 * No domain events: the invitation surface is pull-based (the invitee's
 * board lists pending invites), not pushed through EventPublisherPort,
 * so there is nothing to publish until the Notifications context exists
 * (see docs/doubles-and-special-formats-plan.md).
 */
export class DoublesPair {
  private constructor(
    readonly id: PairId,
    readonly playerA: PlayerId,
    readonly playerB: PlayerId,
    private _status: DoublesPairStatus,
    private _chemistry: number,
  ) {}

  /** A cross-manager invite: one manager has committed their player,
   * awaiting the partner's manager's acceptance. */
  static propose(id: PairId, playerA: PlayerId, playerB: PlayerId): DoublesPair {
    DoublesPair.assertDistinct(playerA, playerB);
    return new DoublesPair(id, playerA, playerB, 'pending', 0);
  }

  /** A same-manager pair: both players belong to one manager, so the
   * pair is live the moment it's created — no acceptance step. */
  static activate(id: PairId, playerA: PlayerId, playerB: PlayerId): DoublesPair {
    DoublesPair.assertDistinct(playerA, playerB);
    return new DoublesPair(id, playerA, playerB, 'active', 0);
  }

  /** Rehydrates a persisted pair (repository adapters only) — no
   * transition performed, same convention as Player.reconstitute()/
   * Coach.reconstitute(). */
  static reconstitute(props: DoublesPairProps): DoublesPair {
    return new DoublesPair(props.id, props.playerA, props.playerB, props.status, props.chemistry ?? 0);
  }

  private static assertDistinct(playerA: PlayerId, playerB: PlayerId): void {
    if (playerA === playerB) {
      throw new Error('A doubles pair needs two distinct players');
    }
  }

  get status(): DoublesPairStatus {
    return this._status;
  }

  get isPending(): boolean {
    return this._status === 'pending';
  }

  get isActive(): boolean {
    return this._status === 'active';
  }

  get isDissolved(): boolean {
    return this._status === 'dissolved';
  }

  get chemistry(): number {
    return this._chemistry;
  }

  /** Grows the pair's chemistry by playing a doubles match together
   * (P7c) — called by SimulateDoublesMatchUseCase for a persistent pair
   * that actually took the court together. Clamped to [0, 100]. */
  gainChemistry(amount: number): void {
    this._chemistry = Math.max(0, Math.min(100, this._chemistry + amount));
  }

  /** True when `playerId` is either member of the pair — what the
   * release cascade and the profile highlight both need to know. */
  involves(playerId: PlayerId): boolean {
    return this.playerA === playerId || this.playerB === playerId;
  }

  /** The OTHER member of the pair for a given player, or null when
   * `playerId` isn't in the pair at all. */
  partnerOf(playerId: PlayerId): PlayerId | null {
    if (this.playerA === playerId) return this.playerB;
    if (this.playerB === playerId) return this.playerA;
    return null;
  }

  /** The invitee's acceptance: pending → active. Only valid while
   * pending — an already-active pair was never waiting on anyone, and
   * an already-dissolved one is gone. */
  accept(): void {
    if (this._status !== 'pending') {
      throw new Error(`Pair ${this.id} is ${this._status}, not pending — it cannot be accepted`);
    }
    this._status = 'active';
  }

  /** Ends the pair: pending → dissolved (a decline) or active →
   * dissolved (a breakup). Idempotent on an already-dissolved pair, so
   * the release cascade can safely dissolve without checking first. */
  dissolve(): void {
    this._status = 'dissolved';
  }
}
