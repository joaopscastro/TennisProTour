import { NotificationPort, OutboundEmail } from '@tennis-manager/application';
import { buildUnsubscribeUrl, signUnsubscribeToken } from '../../notifications/unsubscribeToken';

export interface ResendEmailAdapterOptions {
  apiKey: string;
  /** The `from` header Resend should use (e.g. "Tennis Manager <digest@yourdomain>"). */
  fromEmail: string;
  /** PUBLIC base URL of the API that serves the unsubscribe route — see buildUnsubscribeUrl. */
  appBaseUrl: string;
  /** When null the footer is omitted entirely (and the route 404s), matching its boot-time absence. */
  unsubscribeSecret: string | null;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Notifications bounded context (STAGE 2) — the real `resend` transport.
 * Uses the platform's global `fetch` (Node 18+), so it adds no npm
 * dependency, and throws on any non-2xx so the digest use case marks the
 * delivery `failed` and leaves the cursor where it was (the next run
 * re-covers the missed window).
 *
 * The unsubscribe footer is appended HERE, not by the application-layer
 * renderer: the link needs the signing secret + public base URL, both
 * infrastructure concerns, and it is recipient-specific (the token is
 * signed for the manager this email is for). When the secret is unset
 * the footer is omitted — and the route 404s — so an install that hasn't
 * configured unsubscribe never emits a dead link.
 */
export class ResendEmailAdapter implements NotificationPort {
  constructor(private readonly options: ResendEmailAdapterOptions) {}

  async sendEmail(message: OutboundEmail): Promise<void> {
    const { text, html } = this.withUnsubscribeFooter(message);

    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.options.fromEmail,
        to: message.to,
        subject: message.subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      // Include the provider's own message where available — a bare
      // status code makes a misconfiguration (bad key, unverified
      // domain) needlessly hard to diagnose from logs alone.
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend API returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  private withUnsubscribeFooter(message: OutboundEmail): { text: string; html: string } {
    const secret = this.options.unsubscribeSecret;
    if (!secret || !message.managerId) {
      return { text: message.text, html: message.html };
    }

    const token = signUnsubscribeToken(message.managerId, secret);
    const url = buildUnsubscribeUrl(this.options.appBaseUrl, token);

    return {
      text: `${message.text}\n\n---\nDon't want these emails? Unsubscribe: ${url}`,
      html: `${message.html}\n<hr/>\n<p style="font-size:12px;color:#666">Don't want these emails? <a href="${url}">Unsubscribe</a>.</p>`,
    };
  }
}
