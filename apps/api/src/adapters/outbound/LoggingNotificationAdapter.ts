import { NotificationPort, OutboundEmail } from '@tennis-manager/application';

/**
 * Notifications bounded context (STAGE 2) — the `log` email mode.
 * Contacts nothing and sends nothing; it logs the fact that an email
 * WOULD have gone out. Mirrors LoggingEventPublisher, the same way the
 * notification context's real adapters mirror the event publisher's
 * real counterparts. This is what tests and local `log` mode use, so no
 * developer or test run ever sends a real email.
 *
 * The logged payload is deliberately only `{ to, subject }` — enough to
 * assert a digest was produced without copying the whole body (which
 * contains roster names) into the log stream.
 */
export class LoggingNotificationAdapter implements NotificationPort {
  constructor(private readonly log: (message: string, payload: Record<string, unknown>) => void) {}

  async sendEmail(message: OutboundEmail): Promise<void> {
    this.log('notification email (log mode, not sent)', { to: message.to, subject: message.subject });
  }
}
