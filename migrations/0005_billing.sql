-- Stripe billing: $5/month subscription with a 7-day app-side free trial that
-- starts at a user's first login (tracked by account_id — no card during trial).
-- Billing state lives in its own table, NOT columns on `users`: upsertUser
-- rewrites the users row on every login, while billing is written by a different
-- actor (Stripe webhooks) on a different lifecycle. No row = trial not started
-- (grandfathered users get a fresh trial at their first touch post-deploy).
-- Mirrors the `billing` table in worker/src/db/schema.sql — keep in lockstep.
CREATE TABLE IF NOT EXISTS billing (
  account_id             TEXT PRIMARY KEY,
  trial_started_at       TEXT NOT NULL,       -- first login (or first touch post-deploy)
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  subscription_status    TEXT,                -- Stripe status verbatim; NULL = never subscribed
  current_period_end     TEXT,                -- ISO
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_customer ON billing(stripe_customer_id);
