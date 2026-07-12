// Pure entitlement logic: given a billing row + "now", decide whether the account
// is entitled to use the app, and describe the state for the UI. No I/O — this is
// unit-tested in test/billing.test.ts. See ../db/dao.ts for the billing row and
// routes/billing.ts for the gate that consumes this.

import { addDays } from 'date-fns';
import { UTCDate } from '@date-fns/utc';
import type { BillingInfo, BillingState } from '@shared/contracts';
import type { BillingRow } from '../db/dao';

/** Free-trial length, from a user's first login (or first touch post-deploy). */
export const TRIAL_DAYS = 7;

/**
 * Stripe subscription statuses that entitle. `past_due` is deliberately included:
 * it hands the user Stripe's smart-retry window as a free grace period rather than
 * cutting them off the instant a renewal charge fails.
 */
export const ENTITLED_STATUSES = ['active', 'past_due'] as const;

export interface DerivedBilling extends BillingInfo {
  state: BillingState;
  /** Whether the account may use gated endpoints right now. */
  entitled: boolean;
}

const MS_PER_DAY = 86_400_000;

/**
 * Derive entitlement from a billing row. `exempt` short-circuits everything (the
 * bootstrap admin). A row with an entitling subscription status is `active`;
 * otherwise the 7-day trial window decides `trialing` vs `expired`. A `row` of
 * `null` (should not happen once the gate has inserted one) is treated as expired.
 */
export function deriveBilling(
  row: BillingRow | null,
  nowIso: string,
  opts: { exempt?: boolean } = {},
): DerivedBilling {
  if (opts.exempt) {
    return { state: 'exempt', entitled: true, trialEndsAt: null, daysLeft: null };
  }

  const status = row?.subscriptionStatus ?? null;
  if (status !== null && (ENTITLED_STATUSES as readonly string[]).includes(status)) {
    return { state: 'active', entitled: true, trialEndsAt: null, daysLeft: null };
  }

  if (!row) {
    return { state: 'expired', entitled: false, trialEndsAt: null, daysLeft: null };
  }

  // Not (or no longer) subscribed — the trial window is the only thing that entitles.
  const end = addDays(new UTCDate(row.trialStartedAt), TRIAL_DAYS);
  const nowMs = new UTCDate(nowIso).getTime();
  const trialEndsAt = end.toISOString();
  if (nowMs < end.getTime()) {
    const daysLeft = Math.max(0, Math.ceil((end.getTime() - nowMs) / MS_PER_DAY));
    return { state: 'trialing', entitled: true, trialEndsAt, daysLeft };
  }
  return { state: 'expired', entitled: false, trialEndsAt, daysLeft: 0 };
}

/** Narrow a DerivedBilling to the wire shape sent on /api/me. */
export function toBillingInfo(d: DerivedBilling): BillingInfo {
  return { state: d.state, trialEndsAt: d.trialEndsAt, daysLeft: d.daysLeft };
}
