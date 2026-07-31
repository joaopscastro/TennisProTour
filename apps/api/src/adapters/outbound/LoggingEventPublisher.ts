import { EventPublisherPort } from '@tennis-manager/application';

/** Stand-in until the Notifications context exists: domain events go
 * to the process log instead of email/push adapters. Same port, so
 * the real publisher is a drop-in replacement of this class. */
export class LoggingEventPublisher implements EventPublisherPort {
  constructor(private readonly log: (message: string, payload: Record<string, unknown>) => void) {}

  async publish(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    for (const event of events) {
      this.log(`domain event: ${event.type}`, event.payload);
    }
  }
}
