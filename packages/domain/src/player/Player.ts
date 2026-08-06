import { PlayerId, ManagerId } from '../shared/ids';
import { PlayerAttributes } from './PlayerAttributes';
import { DomainEvent } from '../shared/DomainEvent';
import { TrainingFocus, TrainingPolicy, applyCoachBonus, applyPotentialDiminishingReturns } from './TrainingPolicy';

/**
 * A dormant graduation-carryover bonus parked on this player at an
 * age-band crossing, waiting to be consumed by their first real result
 * in the new band. Named distinctly from (rather than importing) the
 * Competition/Ranking bounded context's own
 * `GraduationCarryover.DormantCarryoverBonus` — per CLAUDE.md principle
 * #5, `domain/player` doesn't import from `domain/ranking` (a
 * different bounded context); the two types are structurally
 * identical on purpose, so the application layer (which already spans
 * both contexts, e.g. SimulateMatchUseCase) can pass a value straight
 * through without any explicit mapping. Player itself has zero opinion
 * about what a "band" means or how the bonus is computed/consumed —
 * see GraduationCarryover.ts for that; Player only stores and clears
 * this one field.
 */
export interface PlayerDormantCarryoverBonus {
  readonly targetBand: 'senior' | 'u14' | 'u16';
  readonly bonusPoints: number;
}

export type PlayerLifecycleStage = 'youth' | 'prime' | 'decline' | 'retired';

export interface PlayerProps {
  id: PlayerId;
  name: string;
  /** Set once at hire time, purely a presentation concern (a flag next
   * to the player's name) — the domain attaches no gameplay meaning to
   * it. Free-text rather than an enum/ISO-code type on purpose: no
   * country reference data exists anywhere else in the domain, and
   * adding one for a display-only field would be exactly the kind of
   * scope CLAUDE.md warns against. */
  nationality: string;
  ageInWeeks: number;
  managerId: ManagerId | null;
  attributes: PlayerAttributes;
  stage: PlayerLifecycleStage;
  fatigue: number; // 0 (fresh) – 100 (exhausted)
  /** The training focus a manager has committed this player to for
   * upcoming weekly ticks (see TrainingPolicy) — null means no
   * standing focus, so no delta applies until one is set. Distinct
   * from applyTraining(), which applies a delta immediately given a
   * focus; this field only records the *standing selection* that
   * AdvanceWorldWeekUseCase reads each week. */
  currentFocus: TrainingFocus | null;
  /** Hidden ceiling on skill-cluster training growth — set once at
   * generation time (see PlayerGenerationPolicy.GeneratedPlayer.potentialCeiling),
   * carried unchanged from whatever talent-pool candidate or custom
   * player this Player originated from. NEVER exposed via any DTO —
   * see playerDto.ts, which deliberately does not read this field. */
  potentialCeiling: number;
  /** null = no pending graduation-carryover bonus. Set by
   * AdvanceWorldWeekUseCase the week this player crosses a junior
   * age-band boundary; cleared by SimulateMatchUseCase the moment it's
   * consumed by this player's first real (points > 0) ranking-ledger
   * entry in the target band. See PlayerDormantCarryoverBonus's doc
   * comment above and domain/ranking/GraduationCarryover.ts for the
   * mechanism. */
  dormantCarryoverBonus: PlayerDormantCarryoverBonus | null;
}

/** Aggregate root for the Player & Roster bounded context.
 *
 * SRP note: Player owns identity + lifecycle transitions only. It does
 * NOT know how to age itself week-over-week (that's
 * PlayerAgingService's job, since aging curves are a policy that may
 * change independently of what a Player *is*), and it does NOT know
 * how to simulate a match (that's the Match Simulation Engine's job,
 * consuming only the immutable PlayerAttributes snapshot).
 */
export class Player {
  private readonly _domainEvents: DomainEvent[] = [];

  private constructor(private props: PlayerProps) {}

  static hire(
    id: PlayerId,
    name: string,
    ageInWeeks: number,
    attributes: PlayerAttributes,
    managerId: ManagerId,
    /** Optional so existing call sites (mostly tests that don't care
     * about nationality) don't all need updating — HirePlayerUseCase,
     * the real product entry point, always passes a real value. */
    nationality = 'XX',
    /** Same "optional trailing param, real entry points always pass a
     * real value" convention as `nationality` above — see this field's
     * doc comment on PlayerProps. Defaults to 100 (skill max), i.e. "no
     * meaningful ceiling," so every pre-existing call site that never
     * heard of potential ceilings keeps training at full, unthrottled
     * rate exactly as before this feature existed. Real entry points
     * (ClaimTalentPoolCandidateUseCase, CreateCustomPlayerUseCase)
     * always pass the real generated value. */
    potentialCeiling = 100,
  ): Player {
    const player = new Player({
      id,
      name,
      nationality,
      ageInWeeks,
      managerId,
      attributes,
      stage: 'youth',
      fatigue: 0,
      currentFocus: null,
      potentialCeiling,
      dormantCarryoverBonus: null,
    });
    player._domainEvents.push({
      type: 'PlayerHired',
      occurredAt: new Date(),
      payload: { playerId: id, managerId },
    });
    return player;
  }

  /** Rehydrates a persisted player (repository adapters only). Unlike
   * hire(), this is not a domain action — it emits NO events; the
   * player being loaded back is not being hired again. */
  static reconstitute(props: PlayerProps): Player {
    return new Player({ ...props });
  }

  get id() {
    return this.props.id;
  }

  get name() {
    return this.props.name;
  }

  get nationality() {
    return this.props.nationality;
  }

  get currentFocus() {
    return this.props.currentFocus;
  }

  get ageInWeeks() {
    return this.props.ageInWeeks;
  }

  get managerId() {
    return this.props.managerId;
  }

  get attributes() {
    return this.props.attributes;
  }

  get stage() {
    return this.props.stage;
  }

  get fatigue() {
    return this.props.fatigue;
  }

  /** Hidden — see PlayerProps.potentialCeiling's doc comment. Read by
   * applyTraining() and by repository adapters that need to persist
   * it; never by anything building an HTTP-facing DTO. */
  get potentialCeiling() {
    return this.props.potentialCeiling;
  }

  get dormantCarryoverBonus() {
    return this.props.dormantCarryoverBonus;
  }

  isRetired(): boolean {
    return this.props.stage === 'retired';
  }

  /** Applies a single training session for one focus (surface XOR
   * skill cluster — see TrainingFocus). The BASE delta is computed by
   * the injected policy, never by Player: this method's job is only to
   * apply whatever delta it's given, not to decide how much a session
   * is worth in a vacuum. What Player DOES own is the further
   * adjustments intrinsic to this specific player/manager rather than
   * a swappable policy concern:
   *  - scaling the base delta down as this player's own hidden
   *    potentialCeiling approaches (see applyPotentialDiminishingReturns),
   *    since a ceiling is a property of the player, not of the training
   *    policy. Surface affinity training is deliberately NOT run
   *    through the ceiling at all — see that function's doc comment.
   *  - scaling the (already ceiling-adjusted, for skill clusters) delta
   *    UP by the manager's coach, if any (see applyCoachBonus) — a
   *    coach's benefit is general training efficiency, unrelated to a
   *    player's own skill ceiling, so unlike the ceiling adjustment
   *    this DOES apply to both surface and skill-cluster training.
   *
   * `coachRating` defaults to null (no coach) so every pre-existing
   * call site that never heard of coaches keeps training exactly as
   * before this feature existed — same "optional trailing param, real
   * entry points pass a real value" convention as hire()'s
   * nationality/potentialCeiling params. The real caller
   * (AdvanceWorldWeekUseCase) looks up the manager's coach and passes
   * its coachRating through. */
  applyTraining(focus: TrainingFocus, policy: TrainingPolicy, coachRating: number | null = null): void {
    if (this.isRetired()) {
      throw new Error(`Cannot train retired player ${this.props.id}`);
    }
    const baseDelta = policy.computeDelta(focus, this.props.stage);
    if (focus.kind === 'surface') {
      const delta = applyCoachBonus(baseDelta, coachRating);
      const updatedAttributes = this.props.attributes.trainedOnSurface(focus.surface, delta);
      this.props = { ...this.props, attributes: updatedAttributes };
      return;
    }
    const currentClusterAverage = this.props.attributes.clusterAverage(focus.cluster);
    const ceilingAdjusted = applyPotentialDiminishingReturns(baseDelta, currentClusterAverage, this.props.potentialCeiling);
    const delta = applyCoachBonus(ceilingAdjusted, coachRating);
    const updatedAttributes = this.props.attributes.trainedOnCluster(focus.cluster, delta);
    this.props = { ...this.props, attributes: updatedAttributes };
  }

  /** Records the standing training focus a manager has committed this
   * player to — does NOT apply any attribute delta itself. The delta
   * is applied later, once per game week, by AdvanceWorldWeekUseCase
   * calling applyTraining() during the weekly tick (the same cadence
   * PlayerAgingService already ages players on). Passing null clears
   * the focus, so no training delta applies until a new one is set. */
  setTrainingFocus(focus: TrainingFocus | null): void {
    if (this.isRetired()) {
      throw new Error(`Cannot set training focus for retired player ${this.props.id}`);
    }
    this.props = { ...this.props, currentFocus: focus };
  }

  applyMatchFatigue(fatigueDelta: number): void {
    this.props = {
      ...this.props,
      fatigue: Math.max(0, Math.min(100, this.props.fatigue + fatigueDelta)),
    };
  }

  recoverFatigue(amount: number): void {
    this.applyMatchFatigue(-amount);
  }

  /** Advances lifecycle stage and age. Called by PlayerAgingService,
   * never invoked directly by application code, so aging rules stay
   * centralized in one place. */
  advanceWeek(newAgeInWeeks: number, newStage: PlayerLifecycleStage, updatedAttributes: PlayerAttributes): void {
    const wasRetired = this.isRetired();
    this.props = {
      ...this.props,
      ageInWeeks: newAgeInWeeks,
      stage: newStage,
      attributes: updatedAttributes,
    };
    if (!wasRetired && newStage === 'retired') {
      this._domainEvents.push({
        type: 'PlayerRetired',
        occurredAt: new Date(),
        payload: { playerId: this.props.id },
      });
    }
  }

  releaseFromManager(): void {
    this.props = { ...this.props, managerId: null };
  }

  /** Records a fresh dormant graduation-carryover bonus (called by
   * AdvanceWorldWeekUseCase at a band crossing) or clears one after
   * it's been consumed (called by SimulateMatchUseCase) — same setter
   * either way, since "record a new one" and "clear the old one"
   * aren't different operations from Player's point of view, just
   * different values. Silently overwrites any bonus already sitting
   * here: see PlayerDormantCarryoverBonus's doc comment on why an
   * unconsumed bonus becoming moot at the next crossing is correct,
   * not a bug. */
  setDormantCarryoverBonus(bonus: PlayerDormantCarryoverBonus | null): void {
    this.props = { ...this.props, dormantCarryoverBonus: bonus };
  }

  pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }
}
