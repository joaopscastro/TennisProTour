/**
 * Minimal domain event shape. Aggregates collect these and the
 * application layer drains them after a use case commits, publishing
 * to the outbound Notifications adapter. Domain code never publishes
 * events itself — that would leak an infrastructure concern into the
 * domain layer.
 */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}
