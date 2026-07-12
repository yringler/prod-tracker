// The ONLY payment-processing file. Thin wrappers around the official `stripe`
// SDK so the rest of the app never touches Stripe types or PCI surface. Uses
// hosted Checkout (subscribe) + the Billing Portal (manage/cancel) — no Stripe.js,
// no card fields. See routes/billing.ts for the HTTP handlers that call these.
//
// Workers notes: construct with `Stripe.createFetchHttpClient()` (Workers has no
// Node http), and verify webhooks with `constructEventAsync` +
// `Stripe.createSubtleCryptoProvider()` — the sync `constructEvent` can't run on
// Workers because signature HMAC there is async (WebCrypto).

import Stripe from 'stripe';
import type { Env } from '../env';

// Pinned to the SDK's bundled version so response shapes are stable across upgrades.
const API_VERSION = '2026-06-24.dahlia';

/** Construct a Stripe client for this request. Cheap; make one per request. */
export function getStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/**
 * Hosted Checkout for the $5/mo subscription. `client_reference_id` carries our
 * account id back on the completed session; we also stamp it into the
 * subscription's metadata so later `customer.subscription.*` webhooks correlate
 * without a Checkout session. Deliberately NO `payment_method_types` — Stripe
 * picks eligible methods dynamically from the Dashboard (better conversion).
 */
export async function createCheckoutSession(
  env: Env,
  accountId: string,
  existingCustomerId?: string,
): Promise<Stripe.Checkout.Session> {
  return getStripe(env).checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: accountId,
    subscription_data: { metadata: { account_id: accountId } },
    success_url: `${env.APP_ORIGIN}/api/billing/confirm?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.APP_ORIGIN}/settings?billing=canceled`,
    ...(existingCustomerId ? { customer: existingCustomerId } : {}),
  });
}

/** Billing Portal session — card updates, cancel, invoices. Returns to /settings. */
export async function createPortalSession(
  env: Env,
  customerId: string,
): Promise<Stripe.BillingPortal.Session> {
  return getStripe(env).billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.APP_ORIGIN}/settings`,
  });
}

/** Retrieve a completed Checkout session (the /confirm redirect verifies it). */
export async function retrieveCheckoutSession(
  env: Env,
  sessionId: string,
): Promise<Stripe.Checkout.Session> {
  return getStripe(env).checkout.sessions.retrieve(sessionId);
}

/** Verify + parse a webhook. Throws if the signature doesn't match (caller → 400). */
export async function verifyWebhookEvent(
  env: Env,
  payload: string,
  sigHeader: string,
): Promise<Stripe.Event> {
  return getStripe(env).webhooks.constructEventAsync(
    payload,
    sigHeader,
    env.STRIPE_WEBHOOK_SECRET,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}

/**
 * ISO of the subscription's current period end. In recent API versions this moved
 * off the Subscription onto its items, so read the item first and fall back to a
 * (possible) legacy top-level field. Null when neither is present.
 */
export function subscriptionPeriodEndIso(sub: Stripe.Subscription): string | null {
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  const fromTop = (sub as unknown as { current_period_end?: number }).current_period_end;
  const epoch = fromItem ?? fromTop;
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}

/** Normalize Stripe's `customer` union (id string | expanded object | null) to an id. */
export function customerIdOf(
  customer: string | { id: string } | null | undefined,
): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id;
}

/** Same for the `subscription` union on a Checkout session. */
export function subscriptionIdOf(
  subscription: string | { id: string } | null | undefined,
): string | null {
  if (!subscription) return null;
  return typeof subscription === 'string' ? subscription : subscription.id;
}
