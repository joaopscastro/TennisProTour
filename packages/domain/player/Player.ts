import { ManagerId, PlayerId } from '../shared/ids';
import { DomainEvent } from '../shared/DomainEvent';
import { PlayerAttributes } from './PlayerAttributes';

export type AgingStage = 'youth' | 'prime' | 'decline' | 'retired';

export interface PlayerProps {
  id: PlayerId;
  managerId: ManagerId;
  name: string;
  ageInYears: number;
  attributes: PlayerAttributes;
  fatigue?: number;
  stage?: AgingStage;
}

/**
 * Player aggregate root. Every mutation goes through a named method —
 * never a raw setter, and never reached into via an `as unknown as
 * {...}` cast from outside (see CLAUDE.md's SOLID discipline section)
 * — so invariants like fatigue staying in [0, 100] can't be bypassed.
 */
export class Player {
  private _attributes: PlayerAttributes;
  private _fatigue: number;
  private _ageInYears: number;
  private _stage: AgingStage;
  private domainEvents: DomainEvent[] = [];

  private constructor(
    readonly id: PlayerId,
    readonly managerId: ManagerId,
    readonly name: string,
    ageInYears: number,
    attributes: PlayerAttributes,
    fatigue: number,
    stage: AgingStage,
  ) {
    this._ageInYears = ageInYears;
    this._attributes = attributes;
    this._fatigue = fatigue;
    this._stage = stage;
  }

  static create(props: PlayerProps): Player {
    return new Player(
      props.id,
      props.managerId,
      props.name,
      props.ageInYears,
      props.attributes,
      props.fatigue ?? 0,
      props.stage ?? 'youth',
    );
  }

  get attributes(): PlayerAttributes {
    return this._attributes;
  }

  get fatigue(): number {
    return this._fatigue;
  }

  get ageInYears(): number {
    return this._ageInYears;
  }

  get stage(): AgingStage {
    return this._stage;
  }

  applyMatchFatigue(amount: number): void {
    this._fatigue = Math.min(100, this._fatigue + amount);
  }

  recoverFatigue(amount: number): void {
    this._fatigue = Math.max(0, this._fatigue - amount);
  }

  growOlder(): void {
    this._ageInYears += 1;
  }

  transitionTo(stage: AgingStage): void {
    if (stage === this._stage) return;
    this._stage = stage;
    this.domainEvents.push({
      type: 'PlayerAgingStageChanged',
      payload: { playerId: this.id, stage },
    });
  }

  declinePhysical(amount: number): void {
    this._attributes = this._attributes.withPhysical({
      speed: this._attributes.physical.speed.adjust(-amount),
      stamina: this._attributes.physical.stamina.adjust(-amount),
      strength: this._attributes.physical.strength.adjust(-amount),
    });
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this.domainEvents;
    this.domainEvents = [];
    return events;
  }
}
