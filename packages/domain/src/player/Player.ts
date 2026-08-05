import { PlayerId, ManagerId } from '../shared/ids';
import { PlayerAttributes } from './PlayerAttributes';
import { DomainEvent } from '../shared/DomainEvent';
import { TrainingFocus, TrainingPolicy, applyPotentialDiminishingReturns } from './TrainingPolicy';

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

  isRetired(): boolean {
    return this.props.stage === 'retired';
  }

  /** Applies a single training session for one focus (surface XOR
   * skill cluster — see TrainingFocus). The BASE delta is computed by
   * the injected policy, never by Player: this method's job is only to
   * apply whatever delta it's given, not to decide how much a session
   * is worth in a vacuum. What Player DOES own is the one further
   * adjustment that's intrinsic to this specific player rather than a
   * swappable policy concern — scaling that base delta down as this
   * player's own hidden potentialCeiling approaches (see
   * applyPotentialDiminishingReturns), since a ceiling is a property
   * of the player, not of the training policy. Surface affinity
   * training is deliberately NOT run through the ceiling at all — see
   * applyPotentialDiminishingReturns's doc comment for why. */
  applyTraining(focus: TrainingFocus, policy: TrainingPolicy): void {
    if (this.isRetired()) {
      throw new Error(`Cannot train retired player ${this.props.id}`);
    }
    const baseDelta = policy.computeDelta(focus, this.props.stage);
    if (focus.kind === 'surface') {
      const updatedAttributes = this.props.attributes.trainedOnSurface(focus.surface, baseDelta);
      this.props = { ...this.props, attributes: updatedAttributes };
      return;
    }
    const currentClusterAverage = this.props.attributes.clusterAverage(focus.cluster);
    const delta = applyPotentialDiminishingReturns(baseDelta, currentClusterAverage, this.props.potentialCeiling);
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

  pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }
}
