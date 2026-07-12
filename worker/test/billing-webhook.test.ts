// Stripe webhook: real signature verification (signed with the SDK's own
// test-header helper), the three handled events applied against the sqlite shim,
// customer-id correlation fallback, and unknown-event no-op. No network — the
// verify path is pure WebCrypto HMAC and the handlers read the event object.
import { beforeEach, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { stripeWebhook } from '../src/routes/billing';
import { SqliteD1 } from './support/sqlite-d1';

const SECRET = 'whsec_test_secret';
const ACCT = 'u1';
const env = { STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: SECRET } as Env;

// A standalone client just to compute test signatures; makes no network calls.
const signer = new Stripe('sk_test_dummy', { apiVersion: '2026-06-24.dahlia' });

function req(payload: string, header: string): Request {
  return new Request('https://x/api/billing/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    body: payload,
  });
}
function signed(obj: unknown, secret = SECRET): Request {
  const payload = JSON.stringify(obj);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret });
  return req(payload, header);
}

function checkoutCompleted(over: Record<string, unknown> = {}) {
  return {
    id: 'evt_cs',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        object: 'checkout.session',
        client_reference_id: ACCT,
        customer: 'cus_1',
        subscription: 'sub_1',
        status: 'complete',
        ...over,
      },
    },
  };
}
function subscriptionEvent(type: string, over: Record<string, unknown> = {}) {
  return {
    id: `evt_${type}`,
    object: 'event',
    type,
    data: {
      object: {
        id: 'sub_1',
        object: 'subscription',
        status: 'active',
        customer: 'cus_1',
        metadata: { account_id: ACCT },
        items: { object: 'list', data: [{ id: 'si_1', current_period_end: 1_799_000_000 }] },
        ...over,
      },
    },
  };
}

describe('signature verification', () => {
  let dao: Dao;
  beforeEach(() => {
    dao = new Dao(new SqliteD1());
  });

  it('accepts a validly-signed event', async () => {
    const res = await stripeWebhook(signed(checkoutCompleted()), env, dao);
    expect(res.status).toBe(200);
  });

  it('rejects a tampered payload (signature no longer matches) with 400', async () => {
    const good = JSON.stringify(checkoutCompleted());
    const header = signer.webhooks.generateTestHeaderString({ payload: good, secret: SECRET });
    const tampered = JSON.stringify(checkoutCompleted({ client_reference_id: 'attacker' }));
    const res = await stripeWebhook(req(tampered, header), env, dao);
    expect(res.status).toBe(400);
    expect(await dao.getBilling('attacker')).toBeNull();
  });

  it('rejects a wrong-secret signature with 400', async () => {
    const res = await stripeWebhook(signed(checkoutCompleted(), 'whsec_wrong'), env, dao);
    expect(res.status).toBe(400);
  });

  it('rejects a missing signature header with 400', async () => {
    const payload = JSON.stringify(checkoutCompleted());
    const res = await stripeWebhook(
      new Request('https://x/api/billing/webhook', { method: 'POST', body: payload }),
      env,
      dao,
    );
    expect(res.status).toBe(400);
  });
});

describe('event handlers', () => {
  let dao: Dao;
  beforeEach(() => {
    dao = new Dao(new SqliteD1());
  });

  it('checkout.session.completed stores the customer + subscription and activates', async () => {
    await stripeWebhook(signed(checkoutCompleted()), env, dao);
    const b = await dao.getBilling(ACCT);
    expect(b?.stripeCustomerId).toBe('cus_1');
    expect(b?.stripeSubscriptionId).toBe('sub_1');
    expect(b?.subscriptionStatus).toBe('active');
  });

  it('customer.subscription.updated updates status + current_period_end', async () => {
    await stripeWebhook(signed(checkoutCompleted()), env, dao);
    await stripeWebhook(signed(subscriptionEvent('customer.subscription.updated', { status: 'past_due' })), env, dao);
    const b = await dao.getBilling(ACCT);
    expect(b?.subscriptionStatus).toBe('past_due');
    expect(b?.currentPeriodEnd).toBe(new Date(1_799_000_000 * 1000).toISOString());
  });

  it('customer.subscription.deleted flips status to canceled', async () => {
    await stripeWebhook(signed(checkoutCompleted()), env, dao);
    await stripeWebhook(signed(subscriptionEvent('customer.subscription.deleted', { status: 'active' })), env, dao);
    expect((await dao.getBilling(ACCT))?.subscriptionStatus).toBe('canceled');
  });

  it('correlates by customer id when the subscription carries no account metadata', async () => {
    // Seed the customer↔account link, then send an event with metadata stripped.
    await dao.startTrialIfAbsent(ACCT);
    await dao.applySubscription(ACCT, {
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: null,
    });
    await stripeWebhook(
      signed(subscriptionEvent('customer.subscription.updated', { status: 'past_due', metadata: {} })),
      env,
      dao,
    );
    expect((await dao.getBilling(ACCT))?.subscriptionStatus).toBe('past_due');
  });

  it('an unknown event type is a 200 no-op', async () => {
    const res = await stripeWebhook(
      signed({ id: 'evt_x', object: 'event', type: 'invoice.paid', data: { object: {} } }),
      env,
      dao,
    );
    expect(res.status).toBe(200);
    expect(await dao.getBilling(ACCT)).toBeNull();
  });
});
