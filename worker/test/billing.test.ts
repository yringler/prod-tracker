// Billing: the pure entitlement math (trial boundaries, entitling statuses,
// exemption) and the DAO/gate wiring (idempotent trial start, grandfathering,
// customer correlation, GDPR). Webhook signature/dispatch lives in
// billing-webhook.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays } from 'date-fns';
import { UTCDate } from '@date-fns/utc';
import { Dao, type BillingRow } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import { TRIAL_DAYS, deriveBilling } from '../src/billing/entitlement';
import { getEntitlement } from '../src/routes/billing';
import { SqliteD1 } from './support/sqlite-d1';

const ACCT = 'u1';
const BOOTSTRAP = 'boot-admin';
const NOW = '2026-07-10T12:00:00.000Z';
const daysAgo = (n: number) => addDays(new UTCDate(NOW), -n).toISOString();

function envWith(bootstrap = ''): Env {
  return { BOOTSTRAP_ADMIN_ACCOUNT_ID: bootstrap } as Env;
}
function ctx(dao: Dao, env: Env, accountId = ACCT): AuthedCtx {
  return { accountId, cloudId: 'c1', sid: 's1', dao, env };
}
function row(partial: Partial<BillingRow>): BillingRow {
  return {
    accountId: ACCT,
    trialStartedAt: NOW,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    updatedAt: NOW,
    ...partial,
  };
}

describe('deriveBilling (pure)', () => {
  it('day 6 of a 7-day trial → trialing, entitled, 1 day left', () => {
    const d = deriveBilling(row({ trialStartedAt: daysAgo(6) }), NOW);
    expect(d.state).toBe('trialing');
    expect(d.entitled).toBe(true);
    expect(d.daysLeft).toBe(1);
  });

  it('day 8 (past the window) → expired, not entitled', () => {
    const d = deriveBilling(row({ trialStartedAt: daysAgo(8) }), NOW);
    expect(d.state).toBe('expired');
    expect(d.entitled).toBe(false);
    expect(d.daysLeft).toBe(0);
  });

  it('a fresh trial reads as the full TRIAL_DAYS left', () => {
    const d = deriveBilling(row({ trialStartedAt: NOW }), NOW);
    expect(d.state).toBe('trialing');
    expect(d.daysLeft).toBe(TRIAL_DAYS);
  });

  it.each(['active', 'past_due'])(
    'status %s entitles even after the trial window closed',
    (status) => {
      const d = deriveBilling(row({ trialStartedAt: daysAgo(30), subscriptionStatus: status }), NOW);
      expect(d.state).toBe('active');
      expect(d.entitled).toBe(true);
    },
  );

  it('a canceled subscription with an expired trial → expired', () => {
    const d = deriveBilling(
      row({ trialStartedAt: daysAgo(30), subscriptionStatus: 'canceled' }),
      NOW,
    );
    expect(d.state).toBe('expired');
    expect(d.entitled).toBe(false);
  });

  it('never subscribed but inside the trial → trialing', () => {
    const d = deriveBilling(row({ trialStartedAt: daysAgo(2), subscriptionStatus: null }), NOW);
    expect(d.state).toBe('trialing');
    expect(d.entitled).toBe(true);
  });

  it('exempt short-circuits regardless of the row', () => {
    const d = deriveBilling(row({ trialStartedAt: daysAgo(30) }), NOW, { exempt: true });
    expect(d.state).toBe('exempt');
    expect(d.entitled).toBe(true);
  });

  it('a null row is treated as expired (not entitled)', () => {
    const d = deriveBilling(null, NOW);
    expect(d.state).toBe('expired');
    expect(d.entitled).toBe(false);
  });
});

describe('startTrialIfAbsent + getEntitlement (DB)', () => {
  let db: SqliteD1;
  let dao: Dao;
  beforeEach(() => {
    db = new SqliteD1();
    dao = new Dao(db);
  });

  const backdate = (accountId: string, iso: string, status?: string) =>
    db
      .prepare(
        `UPDATE billing SET trial_started_at = ?, subscription_status = COALESCE(?, subscription_status) WHERE account_id = ?`,
      )
      .bind(iso, status ?? null, accountId)
      .run();

  it('startTrialIfAbsent is idempotent — a re-touch never resets the trial', async () => {
    await dao.startTrialIfAbsent(ACCT);
    await backdate(ACCT, '2020-01-01T00:00:00.000Z');
    await dao.startTrialIfAbsent(ACCT); // second touch must be a no-op
    expect((await dao.getBilling(ACCT))?.trialStartedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('grandfathering: no row → the gate creates a fresh trial and entitles', async () => {
    expect(await dao.getBilling(ACCT)).toBeNull();
    const ent = await getEntitlement(ctx(dao, envWith()));
    expect(ent.entitled).toBe(true);
    expect(ent.state).toBe('trialing');
    expect(await dao.getBilling(ACCT)).not.toBeNull();
  });

  it('an expired account is not entitled (the gate would 402)', async () => {
    await dao.startTrialIfAbsent(ACCT);
    await backdate(ACCT, daysAgo(30));
    const ent = await getEntitlement(ctx(dao, envWith()));
    expect(ent.entitled).toBe(false);
    expect(ent.state).toBe('expired');
  });

  it('a trialing account passes the gate', async () => {
    await dao.startTrialIfAbsent(ACCT); // trial starts at now
    const ent = await getEntitlement(ctx(dao, envWith()));
    expect(ent.entitled).toBe(true);
    expect(ent.state).toBe('trialing');
  });

  it('an active subscription passes the gate even past the trial', async () => {
    await dao.startTrialIfAbsent(ACCT);
    await backdate(ACCT, daysAgo(30), 'active');
    const ent = await getEntitlement(ctx(dao, envWith()));
    expect(ent.entitled).toBe(true);
    expect(ent.state).toBe('active');
  });

  it('the bootstrap admin is exempt — never gated', async () => {
    const ent = await getEntitlement(ctx(dao, envWith(BOOTSTRAP), BOOTSTRAP));
    expect(ent.state).toBe('exempt');
    expect(ent.entitled).toBe(true);
  });

  it('applySubscription upserts and getBillingByCustomerId correlates', async () => {
    await dao.startTrialIfAbsent(ACCT);
    await dao.applySubscription(ACCT, {
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: '2026-08-10T00:00:00.000Z',
    });
    const byCust = await dao.getBillingByCustomerId('cus_1');
    expect(byCust?.accountId).toBe(ACCT);
    expect(byCust?.subscriptionStatus).toBe('active');
    expect(byCust?.currentPeriodEnd).toBe('2026-08-10T00:00:00.000Z');
  });
});

describe('GDPR wiring', () => {
  let dao: Dao;
  beforeEach(() => {
    dao = new Dao(new SqliteD1());
  });

  it('eraseAccount deletes the billing row', async () => {
    await dao.startTrialIfAbsent(ACCT);
    await dao.eraseAccount(ACCT);
    expect(await dao.getBilling(ACCT)).toBeNull();
  });

  it('accountsForReport includes a billing-only account', async () => {
    await dao.startTrialIfAbsent('billing-only');
    const accounts = await dao.accountsForReport();
    expect(accounts.map((a) => a.accountId)).toContain('billing-only');
  });
});
