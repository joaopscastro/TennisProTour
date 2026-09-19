import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Notifications bounded context (STAGE 2) — the unsubscribe link's
 * tamper-proof token.
 *
 * Shape: `base64url(managerId) + '.' + HMAC-SHA256(payload, secret)`,
 * the signature also base64url-encoded. The payload is PUBLIC (a
 * manager id is not a secret) — the HMAC is what makes the token
 * unguessable, so knowing someone's manager id is not enough to opt
 * them out; you need the server-side `NOTIFICATION_UNSUBSCRIBE_SECRET`
 * too. This is the honesty property the unauthenticated unsubscribe
 * route depends on: it accepts no session, so the URL itself must be
 * unforgeable.
 *
 * A malformed, wrong-length, or tampered token verifies to `null` —
 * `timingSafeEqual` throws on length mismatch, so that is checked
 * explicitly first rather than allowed to throw out of a route.
 */
export function signUnsubscribeToken(managerId: string, secret: string): string {
  const payload = Buffer.from(managerId, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verifies a token and returns the manager id it was signed for, or
 * `null` for anything that doesn't verify (wrong secret, tampered
 * payload/signature, malformed input, or an empty decoded id). Never
 * throws — the route mapping a bad token to 404 must not have to catch.
 */
export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal lengths — check first so a short/long
  // forged signature returns null rather than throwing.
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  const managerId = Buffer.from(payload, 'base64url').toString('utf8');
  return managerId.length > 0 ? managerId : null;
}

/**
 * The public unsubscribe URL embedded in the email footer. The base URL
 * is the PUBLIC base of the API that serves GET /notifications/unsubscribe
 * (`NOTIFICATION_APP_BASE_URL`), not the web app — the route lives on the
 * API and returns its own small HTML confirmation, so the link must reach
 * the API directly. Trailing slashes on the configured base are tolerated.
 */
export function buildUnsubscribeUrl(appBaseUrl: string, token: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
}
