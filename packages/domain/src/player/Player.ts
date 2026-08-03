import { PlayerId, ManagerId } from '../shared/ids';
import { PlayerAttributes } from './PlayerAttributes';
import { DomainEvent } from '../shared/DomainEvent';
import { TrainingFocus, TrainingPolicy } from './TrainingPolicy';

export type PlayerLifecycleStage = 'youth' | 'prime' | 'decline' | 'retired';

export interface PlayerProps {
  id: PlayerId;
  name: string;
  ageInWeeks: number;
  managerId: ManagerId | null;
  attributes: PlayerAttributes;
  stage: PlayerLifecycleStage;
  fatigue: number; // 0 (fresh) – 100 (exhausted)
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
  ): Player {
    const player = new Player({
      id,
      name,
      ageInWeeks,
      managerId,
      attributes,
      stage: 'youth',
      fatigue: 0,
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

  isRetired(): boolean {
    return this.props.stage === 'retired';
  }

  /** Applies a single training session for one focus (surface XOR
   * skill cluster — see TrainingFocus). The delta itself is computed
   * by the injected policy, never by Player: this method's job is
   * only to apply whatever delta it's given to the right part of
   * PlayerAttributes, not to decide how much training is worth. */
  applyTraining(focus: TrainingFocus, policy: TrainingPolicy): void {
    if (this.isRetired()) {
      throw new Error(`Cannot train retired player ${this.props.id}`);
    }
    const delta = policy.computeDelta(focus, this.props.stage);
    const updatedAttributes =
      focus.kind === 'surface'
        ? this.props.attributes.trainedOnSurface(focus.surface, delta)
        : this.props.attributes.trainedOnCluster(focus.cluster, delta);
    this.props = { ...this.props, attributes: updatedAttributes };
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
