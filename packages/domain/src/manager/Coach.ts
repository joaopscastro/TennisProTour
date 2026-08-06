import { CoachId, ManagerId, PlayerId } from '../shared/ids';
import { DomainEvent } from '../shared/DomainEvent';

export interface CoachProps {
  id: CoachId;
  managerId: ManagerId;
  /** The single generic rating driving TrainingPolicy's coach bonus
   * (see applyCoachBonus) — deliberately one number, not specialized
   * surface/skill-cluster coach types. That specialization is a
   * legitimate future idea, explicitly deferred, not a forgotten gap
   * (docs/manager-xp-and-coaching-system.md section 4). */
  coachRating: number;
  /** The player this coach was converted from — lineage/flavor for the
   * UI ("Coach [name], formerly a player") only. Never read by any
   * gameplay rule; a coach's entire mechanical effect is coachRating. */
  sourcePlayerId: PlayerId;
  sourcePlayerName: string;
}

/**
 * Aggregate root for the coach half of the Manager & Progression
 * bounded context. Conversion is PERMANENT — there is deliberately no
 * release/replace/undo method here (docs/manager-xp-and-coaching-system.md
 * section 5's second open question, resolved: a manager commits to
 * "which player to convert" as a one-time, one-way decision per coach
 * slot, same finality as a real retirement-to-coaching career move).
 *
 * Same DomainEvent/pullDomainEvents shape as Player/Tournament, for
 * consistency across aggregates even though nothing outside this
 * codebase currently subscribes to CoachCreated — matches
 * EventPublisherPort's existing generic publish() sink.
 */
export class Coach {
  private readonly _domainEvents: DomainEvent[] = [];

  private constructor(private props: CoachProps) {}

  static convert(
    id: CoachId,
    managerId: ManagerId,
    coachRating: number,
    sourcePlayerId: PlayerId,
    sourcePlayerName: string,
  ): Coach {
    const coach = new Coach({ id, managerId, coachRating, sourcePlayerId, sourcePlayerName });
    coach._domainEvents.push({
      type: 'PlayerConvertedToCoach',
      occurredAt: new Date(),
      payload: { coachId: id, managerId, sourcePlayerId, coachRating },
    });
    return coach;
  }

  /** Rehydrates a persisted coach (repository adapters only) — emits NO
   * events, same convention as Player.reconstitute(). */
  static reconstitute(props: CoachProps): Coach {
    return new Coach({ ...props });
  }

  get id() {
    return this.props.id;
  }

  get managerId() {
    return this.props.managerId;
  }

  get coachRating() {
    return this.props.coachRating;
  }

  get sourcePlayerId() {
    return this.props.sourcePlayerId;
  }

  get sourcePlayerName() {
    return this.props.sourcePlayerName;
  }

  pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }
}
