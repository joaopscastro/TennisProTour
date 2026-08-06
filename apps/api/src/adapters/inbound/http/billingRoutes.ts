import { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { ManagerId } from '@tennis-manager/domain';
import { Dependencies } from '../../../composition';
import { requireManager } from './auth';

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
    async (request, reply) => {
      const manager = await requireManager(request, reply, deps);
      if (!manager) return;
      return deps.billing.createProCheckoutSession(manager.id);
    },
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
        case 'invoice.paid': {
          const invoice = event.data.object;
          // billing_reason distinguishes a genuine renewal
          // ('subscription_cycle') from the initial subscription's own
          // first invoice ('subscription_create', already handled by
          // checkout.session.completed above) — only a real renewal
          // earns a custom-player credit, per the "not an invented
          // in-game clock" requirement this feature was built against.
          if (invoice.billing_reason === 'subscription_cycle') {
            const customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null);
            if (customerId) {
              await deps.billing.grantCustomPlayerCredit(customerId);
              request.log.info({ customerId }, 'custom player credit granted on renewal');
            } else {
              request.log.warn({ invoiceId: invoice.id }, 'invoice.paid renewal without a customer id');
            }
          }
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
