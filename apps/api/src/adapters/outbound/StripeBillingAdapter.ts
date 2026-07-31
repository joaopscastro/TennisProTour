import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { ManagerId } from '@tennis-manager/domain';
import { BillingPort } from '@tennis-manager/application';
import { Db } from '../../db/client';
import { managerEntitlements } from '../../db/schema';

export interface StripeBillingConfig {
  /** Stripe Price id of the Manager Pro monthly subscription. */
  proPriceId: string;
  successUrl: string;
  cancelUrl: string;
  webhookSecret: string;
}

/**
 * Stripe implementation of BillingPort (Manager Pro tier — see the
 * business plan's monetization section). Entitlement reads never call
 * Stripe: isProSubscriber() is a local manager_entitlements lookup,
 * kept current by webhooks. That keeps the hire path fast, keeps game
 * logic working when Stripe is briefly down, and makes the webhook
 * the single writer of entitlement state.
 *
 * The webhook-facing methods (activatePro / deactivateBySubscription
 * / verifyWebhookEvent) are deliberately NOT on BillingPort: game
 * logic asks entitlement questions, only the billing inbound adapter
 * (the webhook route) mutates entitlement state.
 */
export class StripeBillingAdapter implements BillingPort {
  constructor(
    private readonly db: Db,
    private readonly stripe: Stripe,
    private readonly config: StripeBillingConfig,
  ) {}

  async isProSubscriber(managerId: ManagerId): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(managerEntitlements)
      .where(eq(managerEntitlements.managerId, managerId))
      .limit(1);
    return rows.length > 0 && rows[0].status === 'active';
  }

  async createProCheckoutSession(managerId: ManagerId): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: this.config.proPriceId, quantity: 1 }],
      // The manager comes back to us in the webhook via this field —
      // it's the join key between Stripe's world and ours.
      client_reference_id: managerId,
      success_url: this.config.successUrl,
      cancel_url: this.config.cancelUrl,
    });
    if (!session.url) {
      throw new Error('Stripe returned a checkout session without a redirect URL');
    }
    return { url: session.url };
  }

  /** Verifies the webhook signature and parses the event. Throws on a
   * bad signature — the route turns that into a 400. */
  verifyWebhookEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
  }

  async activatePro(managerId: ManagerId, stripeCustomerId: string | null, stripeSubscriptionId: string | null): Promise<void> {
    const row = {
      managerId,
      stripeCustomerId,
      stripeSubscriptionId,
      status: 'active' as const,
    };
    await this.db
      .insert(managerEntitlements)
      .values(row)
      .onConflictDoUpdate({ target: managerEntitlements.managerId, set: { ...row, updatedAt: new Date() } });
  }

  async deactivateBySubscription(stripeSubscriptionId: string): Promise<void> {
    await this.db
      .update(managerEntitlements)
      .set({ status: 'canceled', updatedAt: new Date() })
      .where(eq(managerEntitlements.stripeSubscriptionId, stripeSubscriptionId));
  }
}
