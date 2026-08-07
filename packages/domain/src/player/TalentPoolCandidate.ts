import { PlayerAttributes } from './PlayerAttributes';
import { GeneratedPlayer, PlayerRarityTier, PotentialTier } from './PlayerGenerationPolicy';
import { GameWeek, ManagerId, TalentPoolCandidateId } from '../shared/ids';
import { weeksBetween } from '../world/GameWorld';

export type TalentPoolCandidateStatus = 'available' | 'claimed' | 'expired';

/** How many in-game weeks an unclaimed candidate sits in the pool
 * before the weekly refresh sweeps it out (see RefreshTalentPoolUseCase). */
export const TALENT_POOL_EXPIRY_WEEKS = 2;

export interface TalentPoolCandidateProps {
  id: TalentPoolCandidateId;
  name: string;
  nationality: string;
  tier: PlayerRarityTier;
  /** See GeneratedPlayer.ageInWeeks's doc comment — carried on the
   * candidate so it transfers unchanged onto the resulting Player once
   * claimed, same as potentialCeiling below. */
  ageInWeeks: number;
  attributes: PlayerAttributes;
  /** The real, hidden ceiling — see GeneratedPlayer.potentialCeiling's
   * doc comment. Carried on the candidate so it transfers unchanged
   * into the resulting Player once claimed (ClaimTalentPoolCandidateUseCase
   * reads it off `claimed.potentialCeiling`), but MUST NEVER be
   * serialized by any adapter that turns a candidate into an API
   * response — only `potentialTier` below is for that. */
  potentialCeiling: number;
  /** The noisy, coarse signal scouting actually exposes — see
   * GeneratedPlayer.potentialTier's doc comment. */
  potentialTier: PotentialTier;
  generatedAtWeek: GameWeek;
  status: TalentPoolCandidateStatus;
  claimedByManagerId: ManagerId | null;
}

/**
 * A generated player sitting unowned in the talent pool, visible to
 * every manager, until claimed or expired. Deliberately NOT a Player —
 * it has no manager, lifecycle stage, or fatigue; those only start to
 * exist once ClaimTalentPoolCandidateUseCase converts a claimed
 * candidate into a real Player aggregate.
 *
 * Race-safety note: markClaimed()/markExpired() enforce the "only from
 * available" invariant on a SINGLE in-memory instance — they do NOT,
 * by themselves, make concurrent claims safe. Two managers hitting
 * claim at the same instant each load their own instance from the
 * database, so an in-memory guard here can't see the other's write.
 * The actual race-safety guarantee is
 * TalentPoolCandidateRepository.claimIfAvailable()'s single atomic
 * conditional UPDATE at the database layer (see that port's doc
 * comment) — this aggregate's guard exists so a caller that already
 * holds an atomically-claimed row can build consistent resulting
 * state, and so tests can exercise the invariant without a database.
 */
export class TalentPoolCandidate {
  private constructor(private props: TalentPoolCandidateProps) {}

  /** Produces a freshly-generated, available candidate from whatever
   * PlayerGenerationPolicy handed back — the id is decided by the
   * caller (RefreshTalentPoolUseCase, via an injected id generator),
   * matching this codebase's convention that aggregates never invent
   * their own identity (see Player.hire(), Tournament.open()). */
  static generate(id: TalentPoolCandidateId, generated: GeneratedPlayer, generatedAtWeek: GameWeek): TalentPoolCandidate {
    return new TalentPoolCandidate({
      id,
      name: generated.name,
      nationality: generated.nationality,
      tier: generated.tier,
      ageInWeeks: generated.ageInWeeks,
      attributes: generated.attributes,
      potentialCeiling: generated.potentialCeiling,
      potentialTier: generated.potentialTier,
      generatedAtWeek,
      status: 'available',
      claimedByManagerId: null,
    });
  }

  /** Rehydrates a persisted candidate (repository adapters only). */
  static reconstitute(props: TalentPoolCandidateProps): TalentPoolCandidate {
    return new TalentPoolCandidate({ ...props });
  }

  get id(): TalentPoolCandidateId {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get nationality(): string {
    return this.props.nationality;
  }

  get tier(): PlayerRarityTier {
    return this.props.tier;
  }

  get ageInWeeks(): number {
    return this.props.ageInWeeks;
  }

  get attributes(): PlayerAttributes {
    return this.props.attributes;
  }

  /** Hidden — see TalentPoolCandidateProps.potentialCeiling's doc
   * comment. Callers converting a claimed candidate into a Player need
   * this; HTTP-facing DTO mappers must never call it. */
  get potentialCeiling(): number {
    return this.props.potentialCeiling;
  }

  get potentialTier(): PotentialTier {
    return this.props.potentialTier;
  }

  get generatedAtWeek(): GameWeek {
    return this.props.generatedAtWeek;
  }

  get status(): TalentPoolCandidateStatus {
    return this.props.status;
  }

  get claimedByManagerId(): ManagerId | null {
    return this.props.claimedByManagerId;
  }

  isAvailable(): boolean {
    return this.props.status === 'available';
  }

  isExpiredAsOf(currentWeek: GameWeek): boolean {
    return weeksBetween(this.props.generatedAtWeek, currentWeek) > TALENT_POOL_EXPIRY_WEEKS;
  }

  markClaimed(managerId: ManagerId): void {
    if (this.props.status !== 'available') {
      throw new Error(`Talent pool candidate ${this.props.id} is not available (status: ${this.props.status})`);
    }
    this.props = { ...this.props, status: 'claimed', claimedByManagerId: managerId };
  }

  /** No-op if the candidate isn't (still) available — expiring an
   * already-claimed candidate would silently discard who claimed it,
   * which should never happen given RefreshTalentPoolUseCase only ever
   * calls this on candidates it just read as available, but the guard
   * keeps the invariant true regardless of caller discipline. */
  markExpired(): void {
    if (this.props.status !== 'available') return;
    this.props = { ...this.props, status: 'expired' };
  }
}
