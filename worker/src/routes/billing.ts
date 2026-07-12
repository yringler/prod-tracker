// Billing HTTP handlers. The entitlement gate + subscribe/portal redirects + the
// Checkout-confirm return + the Stripe webhook. All Stripe SDK calls go through
// ../billing/stripe.ts (the single payment-processing file); this file only
// dispatches. Entitlement math is pure in ../billing/entitlement.ts.

import type { CheckoutSessionResponse, PortalSessionResponse } from '@shared/contracts';
import type Stripe from 'stripe';
import type { Dao } from '../db/dao';
import type { Env } from '../env';
import { type AuthedCtx, error, json } from '../http';
import { log, errFields } from '../log';
import { type DerivedBilling, deriveBilling } from '../billing/entitlement';
import {
  createCheckoutSession,
  createPortalSession,
  customerIdOf,
  retrieveCheckoutSession,
  subscriptionIdOf,
  subscriptionPeriodEndIso,
  verifyWebhookEvent,
} from '../billing/stripe';

const nowIso = () => new Date().toISOString();

/**
 * Resolve the caller's entitlement, lazily starting the trial. Exempts ONLY the
 * bootstrap admin (mirrors http.requireAdmin's recovery hatch) — appointing an
 * admin must never be a payment bypass. Called by the gate in index.ts and by
 * /api/me, so it's idempotent and cheap.
 */
export async function getEntitlement(ctx: AuthedCtx): Promise<DerivedBilling> {
  const exempt =
    !!ctx.env.BOOTSTRAP_ADMIN_ACCOUNT_ID &&
    ctx.accountId === ctx.env.BOOTSTRAP_ADMIN_ACCOUNT_ID;
  await ctx.dao.startTrialIfAbsent(ctx.accountId);
  const row = await ctx.dao.getBilling(ctx.accountId);
  return deriveBilling(row, nowIso(), { exempt });
}

/** POST /api/billing/checkout — hosted Checkout URL for the $5/mo plan. */
export async function createCheckout(ctx: AuthedCtx): Promise<Response> {
  const billing = await ctx.dao.getBilling(ctx.accountId);
  const session = await createCheckoutSession(
    ctx.env,
    ctx.accountId,
    billing?.stripeCustomerId ?? undefined,
  );
  if (!session.url) return error(502, 'stripe returned no checkout url');
  return json({ url: session.url } satisfies CheckoutSessionResponse);
}

/** POST /api/billing/portal — Billing Portal URL. 409 if never subscribed. */
export async function createPortal(ctx: AuthedCtx): Promise<Response> {
  const billing = await ctx.dao.getBilling(ctx.accountId);
  if (!billing?.stripeCustomerId) return error(409, 'no billing customer', 'NO_CUSTOMER');
  const session = await createPortalSession(ctx.env, billing.stripeCustomerId);
  return json({ url: session.url } satisfies PortalSessionResponse);
}

/**
 * GET /api/billing/confirm?session_id — the Checkout success return. Retrieves the
 * session, verifies it's this account's completed session, and applies the same
 * idempotent upsert as the webhook. This closes the webhook race on return: the
 * SameSite=Lax `sid` cookie IS sent on this top-level GET, so we can trust ctx.
 */
export async function confirmCheckout(req: Request, ctx: AuthedCtx): Promise<Response> {
  const sessionId = new URL(req.url).searchParams.get('session_id');
  if (!sessionId) return redirect('/settings?billing=canceled');
  try {
    const session = await retrieveCheckoutSession(ctx.env, sessionId);
    if (session.client_reference_id !== ctx.accountId || session.status !== 'complete') {
      return redirect('/settings?billing=canceled');
    }
    await applyCheckoutSession(ctx.dao, session);
    return redirect('/settings?billing=success');
  } catch (e) {
    log.error('billing confirm failed', errFields(e));
    return redirect('/settings?billing=canceled');
  }
}

/**
 * POST /api/billing/webhook — PUBLIC (Stripe sends no cookie). Read the RAW body
 * before any parse, verify the signature (400 on failure), handle exactly three
 * events, and 200 on everything else. A handler that throws returns 500 so Stripe
 * retries (all writes are idempotent, so a retry is safe).
 */
export async function stripeWebhook(req: Request, env: Env, dao: Dao): Promise<Response> {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return error(400, 'missing stripe-signature');
  const payload = await req.text(); // RAW body — signature is over the exact bytes.

  let event: Stripe.Event;
  try {
    event = await verifyWebhookEvent(env, payload, sig);
  } catch (e) {
    log.warn('stripe webhook: signature verification failed', errFields(e));
    return error(400, 'invalid signature');
  }

  switch (event.type) {
    case 'checkout.session.completed':
      await applyCheckoutSession(dao, event.data.object);
      break;
    case 'customer.subscription.updated':
      await applySubscriptionObject(dao, event.data.object);
      break;
    case 'customer.subscription.deleted':
      await applySubscriptionObject(dao, event.data.object, 'canceled');
      break;
    default:
      break; // Unhandled event types are a no-op 200.
  }
  return json({ received: true });
}

// --- helpers -----------------------------------------------------------------

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/**
 * Persist a completed Checkout session. Correlates account via client_reference_id
 * (falling back to subscription metadata). A `complete` session means the first
 * invoice was paid, so we optimistically store `active` and leave current_period_end
 * for the `customer.subscription.updated` webhook that Stripe fires right after —
 * that event carries the authoritative status + period and self-corrects any edge
 * case (e.g. an incomplete payment). Shared by /confirm and the webhook, and no
 * extra Stripe round-trip. Entitlement only reads status ∈ {active, past_due}, so
 * a briefly-null period end is fine.
 */
async function applyCheckoutSession(
  dao: Dao,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const accountId = session.client_reference_id ?? session.metadata?.['account_id'] ?? null;
  if (!accountId) {
    log.warn('billing: checkout session has no account correlation', { id: session.id });
    return;
  }
  await dao.applySubscription(accountId, {
    customerId: customerIdOf(session.customer),
    subscriptionId: subscriptionIdOf(session.subscription),
    status: session.status === 'complete' ? 'active' : null,
    currentPeriodEnd: null,
  });
}

/**
 * Persist a subscription webhook object. Correlation order: subscription metadata
 * account_id → customer id lookup. `statusOverride` forces `canceled` on the
 * delete event. No account correlation → logged no-op (still a 200 to Stripe).
 */
async function applySubscriptionObject(
  dao: Dao,
  sub: Stripe.Subscription,
  statusOverride?: string,
): Promise<void> {
  const customerId = customerIdOf(sub.customer);
  let accountId = sub.metadata?.['account_id'] ?? null;
  if (!accountId && customerId) {
    accountId = (await dao.getBillingByCustomerId(customerId))?.accountId ?? null;
  }
  if (!accountId) {
    log.warn('billing: subscription event has no account correlation', { id: sub.id });
    return;
  }
  await dao.applySubscription(accountId, {
    customerId,
    subscriptionId: sub.id,
    status: statusOverride ?? sub.status,
    currentPeriodEnd: subscriptionPeriodEndIso(sub),
  });
}
