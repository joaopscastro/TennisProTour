import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { FastifyInstance } from 'fastify';
import { ManagerId, PlayerAttributes, Skill, SurfaceAffinities, TalentPoolCandidate, TalentPoolCandidateId } from '@tennis-manager/domain';
import * as schema from '../../../db/schema';
import { testConnectionString } from '../../../db/testConnection';
import { buildDependencies, Dependencies } from '../../../composition';
import { buildApp } from '../../../app';

const connectionString = testConnectionString();
const WEBHOOK_SECRET = 'whsec_test_secret';

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });
// Only used for its offline signature helper — no network calls.
const stripeForSigning = new Stripe('sk_test_dummy');

let app: FastifyInstance;
let deps: Dependencies;
let matchLogDirectory: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: './drizzle' });
  matchLogDirectory = await mkdtemp(join(tmpdir(), 'billing-test-'));
  deps = buildDependencies({
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
  // ranking_ledger/titles have FKs to both players and tournaments —
  // must go before either; peak_rankings/training_schedule only
  // reference players.
  await db.delete(schema.rankingLedger);
  await db.delete(schema.titles);
  await db.delete(schema.peakRankings);
  await db.delete(schema.trainingSchedule);
  await db.delete(schema.tournamentMatches);
  await db.delete(schema.tournamentEntries);
  await db.delete(schema.tournaments);
  await db.delete(schema.players);
  await db.delete(schema.talentPoolCandidates);
  await db.delete(schema.managerEntitlements);
  await db.delete(schema.managerProgression);
});

afterAll(async () => {
  await app.close();
  await rm(matchLogDirectory, { recursive: true, force: true });
  await pool.end();
});

function fixedAttributes(base: number): PlayerAttributes {
  return new PlayerAttributes({
    technical: { serve: Skill.of(base), forehand: Skill.of(base), backhand: Skill.of(base), volley: Skill.of(base) },
    physical: { speed: Skill.of(base), stamina: Skill.of(base), strength: Skill.of(base) },
    mental: { consistency: Skill.of(base), clutch: Skill.of(base) },
    surfaceAffinities: SurfaceAffinities.initial(),
  });
}

/** Ample XP for these HTTP-level billing/roster-cap tests, which care
 * about entitlement-driven roster caps, not claim pricing itself (see
 * ClaimTalentPoolCandidateUseCase.test.ts for pricing coverage). */
const AMPLE_XP_FOR_TESTS = 100_000;

/** Seeds a talent pool candidate at a fixed id, funds the claiming
 * manager with ample XP (claiming costs XP now — see
 * docs/manager-xp-and-coaching-system.md), then claims it via the real
 * HTTP endpoint — hiring is pool-based now (see docs/CLAUDE.md), so
 * this replaces the old direct POST /players helper while keeping the
 * same `hirePlayer(id, managerId)` call shape the roster-cap tests
 * below rely on. */
async function hirePlayer(id: string, managerId: string): Promise<number> {
  await deps.talentPoolCandidates.save(
    TalentPoolCandidate.generate(
      TalentPoolCandidateId(id),
      { name: `Player ${id}`, nationality: 'BR', tier: 'common', ageInWeeks: 750, attributes: fixedAttributes(30), potentialCeiling: 100, potentialTier: 'promising', physicalCeilings: { speed: 100, stamina: 100, strength: 100 } },
      { season: 1, week: 1 },
    ),
  );
  await deps.managerXp.credit(ManagerId(managerId), AMPLE_XP_FOR_TESTS);
  const response = await app.inject({ method: 'POST', url: `/talent-pool/${id}/claim`, headers: { 'x-dev-manager-id': managerId }, payload: { managerId } });
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

/** billingReason 'subscription_cycle' is a genuine renewal (earns a
 * custom-player credit); 'subscription_create' is the initial
 * checkout's own first invoice (already handled by
 * checkout.session.completed, must NOT also grant a credit). */
function invoicePaidEvent(customerId: string, billingReason: string, id = 'evt_invoice'): Record<string, unknown> {
  return {
    id,
    object: 'event',
    type: 'invoice.paid',
    data: { object: { id: 'in_1', object: 'invoice', customer: customerId, billing_reason: billingReason } },
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
      type: 'payment_intent.succeeded', // genuinely unhandled — invoice.paid IS handled now (renewal credits)
      data: { object: { id: 'pi_1', object: 'payment_intent' } },
    });
    expect(status).toBe(200);
  });

  it('grants exactly one custom-player credit per invoice.paid renewal (subscription_cycle), never on the initial subscription_create invoice', async () => {
    await postWebhook(checkoutCompletedEvent('m1', 'sub_123')); // sets stripeCustomerId = cus_1, credits = 0

    expect((await app.inject({ method: 'GET', url: '/managers/m1/entitlement', headers: { 'x-dev-manager-id': 'm1' } })).json().customPlayerCredits).toBe(0);

    // The initial invoice for the subscription itself must NOT grant a credit.
    expect(await postWebhook(invoicePaidEvent('cus_1', 'subscription_create', 'evt_initial'))).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/managers/m1/entitlement', headers: { 'x-dev-manager-id': 'm1' } })).json().customPlayerCredits).toBe(0);

    // A real renewal grants exactly one.
    expect(await postWebhook(invoicePaidEvent('cus_1', 'subscription_cycle', 'evt_renewal_1'))).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/managers/m1/entitlement', headers: { 'x-dev-manager-id': 'm1' } })).json().customPlayerCredits).toBe(1);

    // A second renewal stacks another one (2 total), not resets/replaces.
    expect(await postWebhook(invoicePaidEvent('cus_1', 'subscription_cycle', 'evt_renewal_2'))).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/managers/m1/entitlement', headers: { 'x-dev-manager-id': 'm1' } })).json().customPlayerCredits).toBe(2);
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
