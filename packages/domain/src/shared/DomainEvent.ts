/** Marker interface for domain events. Kept deliberately minimal —
 * just enough shape for EventPublisherPort to accept anything an
 * aggregate emits, without the Notifications context (not yet built)
 * forcing every aggregate to import a heavier event base class. */
export interface DomainEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}
