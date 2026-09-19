import { FastifyInstance } from 'fastify';
import { ManagerId } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';
import { verifyUnsubscribeToken } from '../../../notifications/unsubscribeToken';
import { requireManager } from './auth';

/**
 * Minimal, self-contained confirmation page for the unsubscribe flow.
 * Deliberately NOT a redirect into the web app: an email link must work
 * even when the recipient isn't signed in, and this is the one place a
 * non-authenticated human is expected to land.
 */
const UNSUBSCRIBED_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 24px;color:#1c1c1c">
  <h1 style="font-size:20px">You're unsubscribed</h1>
  <p>You won't receive any more weekly results digests. You can turn them back on any time from your Manager Pro page.</p>
</body>
</html>`;

/**
 * Notifications bounded context (STAGE 2) — the manager-facing preference
 * surface and the unsubscribe landing page.
 *
 * The unsubscribe route is NECESSARILY unauthenticated: it is clicked
 * from an email, where there is no session. What makes that safe is the
 * signed token — a manager id alone is not enough to unsubscribe someone;
 * the URL must also carry a valid HMAC (see unsubscribeToken.ts), so the
 * link is unguessable and the endpoint gives an attacker nothing. It
 * still rides the app-wide rate limiter (registered in app.ts). When the
 * secret is unset (mode `off`/`log`, or a `resend` install that skipped
 * it) the route 404s, matching the footer being omitted server-side — no
 * dead/working-link asymmetry.
 *
 * `/me/notification-preferences` is the authenticated counterpart the
 * Manager Pro page toggles. Default is ON: the digest sender treats an
 * absent preference row as opted in, so this route only ever writes an
 * explicit opt-out/opt-in.
 */
export function registerNotificationRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get<{ Querystring: { token?: string } }>('/notifications/unsubscribe', async (request, reply) => {
    const secret = process.env.NOTIFICATION_UNSUBSCRIBE_SECRET;
    const token = request.query.token;
    if (!secret || !token) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const managerId = verifyUnsubscribeToken(token, secret);
    if (managerId === null) {
      // Same response for "no secret", "malformed", and "tampered" — the
      // route never confirms whether a given manager id exists or whether
      // a near-miss token was close.
      return reply.code(404).send({ error: 'Not found' });
    }

    await deps.notificationPreferences.setOptOut(ManagerId(managerId), true);
    return reply.code(200).header('content-type', 'text/html; charset=utf-8').send(UNSUBSCRIBED_HTML);
  });

  app.get('/me/notification-preferences', async (request, reply) => {
    const manager = await requireManager(request, reply, deps);
    if (!manager) return;
    const digestOptOut = await deps.notificationPreferences.isOptedOut(manager.id);
    return { digestOptOut };
  });

  app.put<{ Body: { digestOptOut: boolean } }>(
    '/me/notification-preferences',
    {
      schema: {
        body: {
          type: 'object',
          required: ['digestOptOut'],
          additionalProperties: false,
          properties: { digestOptOut: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      await deps.notificationPreferences.setOptOut(manager.id, request.body.digestOptOut);
      return { digestOptOut: request.body.digestOptOut };
    },
  );
}
