import { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { ManagerId } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';

/**
 * Billing inbound adapters: checkout entry point + the Stripe webhook
 * that is the single writer of entitlement state. Entitlement flips
 * ONLY here, on provider-confirmed events — never optimistically when
 * a checkout session gets created.
 */
export function registerBillingRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.post<{ Body: { managerId: string } }>(
    '/billing/checkout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['managerId'],
          properties: { managerId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (request) => deps.billing.createProCheckoutSession(ManagerId(request.body.managerId)),
  );

  // Webhook lives in its own scope: Stripe signature verification
  // needs the raw request bytes, so this scope's JSON parser hands
  // the body through unparsed instead of the default JSON parse.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    scope.post('/billing/webhook', async (request, reply) => {
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        return reply.code(400).send({ error: 'Missing stripe-signature header' });
      }

      let event: Stripe.Event;
      try {
        event = deps.billing.verifyWebhookEvent(request.body as Buffer, signature);
      } catch {
        return reply.code(400).send({ error: 'Invalid webhook signature' });
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const managerId = session.client_reference_id;
          if (managerId) {
            await deps.billing.activatePro(
              ManagerId(managerId),
              typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null),
              typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
            );
            request.log.info({ managerId }, 'manager pro activated');
          } else {
            request.log.warn({ sessionId: session.id }, 'checkout completed without client_reference_id');
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          await deps.billing.deactivateBySubscription(subscription.id);
          request.log.info({ subscriptionId: subscription.id }, 'manager pro deactivated');
          break;
        }
        default:
          // Unhandled event types are acknowledged, not errored —
          // Stripe retries non-2xx responses.
          break;
      }

      return { received: true };
    });
  });
}
