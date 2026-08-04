import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { FastifyInstance } from 'fastify';
import * as schema from '../../../db/schema';
import { buildDependencies } from '../../../composition';
import { buildApp } from '../../../app';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://tennis:tennis@localhost:5432/tennis_manager';
const WEBHOOK_SECRET = 'whsec_test_secret';

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });
// Only used for its offline signature helper — no network calls.
const stripeForSigning = new Stripe('sk_test_dummy');

let app: FastifyInstance;
let matchLogDirectory: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  matchLogDirectory = await mkdtemp(join(tmpdir(), 'billing-test-'));
  const deps = buildDependencies({
    db,
    matchLogDirectory,
    logEvent: () => {},
    stripe: {
      secretKey: 'sk_test_dummy',
      config: {
        proPriceId: 'price_test',
        successUrl: 'http://localhost:3000/billing/success',
        cancelUrl: 'http://localhost:3000/billing/cancel',
        webhookSecret: WEBHOOK_SECRET,
      },
    },
  });
  app = buildApp({ deps, matchLogDirectory, logger: false });
  await app.ready();
});

beforeEach(async () => {
  // ranking_ledger has FKs to both players and tournaments — must go
  // before either.
  await db.delete(schema.rankingLedger);
  await db.delete(schema.tournamentMatches);
  await db.delete(schema.tournamentEntries);
  await db.delete(schema.tournaments);
  await db.delete(schema.players);
  await db.delete(schema.managerEntitlements);
});

afterAll(async () => {
  await app.close();
  await rm(matchLogDirectory, { recursive: true, force: true });
  await pool.end();
});

async function hirePlayer(id: string, managerId: string): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/players',
    payload: { playerId: id, name: `Player ${id}`, nationality: 'BR', managerId, startingAgeInWeeks: 20 * 52 },
  });
  return response.statusCode;
}

/** Signs a fabricated Stripe event exactly the way Stripe would —
 * generateTestHeaderString is pure local crypto, no network. */
function signedWebhook(event: Record<string, unknown>): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  const signature = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, signature };
}

async function postWebhook(event: Record<string, unknown>, overrideSignature?: string): Promise<number> {
  const { payload, signature } = signedWebhook(event);
  const response = await app.inject({
    method: 'POST',
    url: '/billing/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': overrideSignature ?? signature },
    payload,
  });
  return response.statusCode;
}

function checkoutCompletedEvent(managerId: string, subscriptionId: string): Record<string, unknown> {
  return {
    id: 'evt_1',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        object: 'checkout.session',
        client_reference_id: managerId,
        customer: 'cus_1',
        subscription: subscriptionId,
      },
    },
  };
}

function subscriptionDeletedEvent(subscriptionId: string): Record<string, unknown> {
  return {
    id: 'evt_2',
    object: 'event',
    type: 'customer.subscription.deleted',
    data: { object: { id: subscriptionId, object: 'subscription' } },
  };
}

describe('Stripe billing', () => {
  it('flips a manager to Pro on checkout.session.completed and back on customer.subscription.deleted, with the roster cap following', async () => {
    // Free tier: cap 2.
    expect(await hirePlayer('p1', 'm1')).toBe(201);
    expect(await hirePlayer('p2', 'm1')).toBe(201);
    expect(await hirePlayer('p3', 'm1')).toBe(409);

    // Pro activation via the provider-confirmed webhook.
    expect(await postWebhook(checkoutCompletedEvent('m1', 'sub_123'))).toBe(200);

    // Pro tier: cap 4.
    expect(await hirePlayer('p3', 'm1')).toBe(201);
    expect(await hirePlayer('p4', 'm1')).toBe(201);
    expect(await hirePlayer('p5', 'm1')).toBe(409);

    // Cancellation drops the entitlement...
    expect(await postWebhook(subscriptionDeletedEvent('sub_123'))).toBe(200);

    // ...and the free cap applies again (roster already over it).
    expect(await hirePlayer('p5', 'm1')).toBe(409);
  });

  it('rejects a webhook with a bad signature without touching entitlements', async () => {
    const status = await postWebhook(checkoutCompletedEvent('m1', 'sub_999'), 't=1,v1=deadbeef');
    expect(status).toBe(400);

    // Still free tier: third hire refused.
    expect(await hirePlayer('p1', 'm1')).toBe(201);
    expect(await hirePlayer('p2', 'm1')).toBe(201);
    expect(await hirePlayer('p3', 'm1')).toBe(409);
  });

  it('acknowledges unhandled event types without erroring', async () => {
    const status = await postWebhook({
      id: 'evt_3',
      object: 'event',
      type: 'invoice.paid',
      data: { object: { id: 'in_1', object: 'invoice' } },
    });
    expect(status).toBe(200);
  });

  it('rejects a webhook missing the signature header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(checkoutCompletedEvent('m1', 'sub_1')),
    });
    expect(response.statusCode).toBe(400);
  });
});
