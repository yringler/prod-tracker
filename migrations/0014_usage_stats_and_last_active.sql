-- Operator visibility: a D1 usage meter + a throttled "last active" stamp.
--
-- Idempotency posture: `ALTER TABLE ... ADD COLUMN` is additive-and-once (as
-- 0005/0008/0011/0013 do) — wrangler's d1_migrations ledger guarantees a single
-- execution. `CREATE TABLE IF NOT EXISTS` is genuinely idempotent.
-- Mirrors worker/src/db/schema.sql.

-- 1) Hourly D1 usage per source ("GET /api/risk/boards/:id", "cron:poll", ...),
--    accumulated in-isolate from each query's meta.rows_read / rows_written and
--    flushed as one additive upsert per (bucket, source). No account column: this
--    is an infrastructure meter, not a per-user log. Written ONLY by
--    worker/src/usage/store.ts; pruned to USAGE_RETENTION_DAYS by the cron flush.
CREATE TABLE IF NOT EXISTS usage_stats (
  bucket        TEXT NOT NULL,             -- ISO UTC hour start, e.g. 2026-11-17T13:00:00.000Z
  source        TEXT NOT NULL,
  invocations   INTEGER NOT NULL DEFAULT 0,
  queries       INTEGER NOT NULL DEFAULT 0,
  rows_read     INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, source)
);

-- 2) When the user last made an authenticated request, stamped at most once per
--    LAST_ACTIVE_RESOLUTION_MS (hourly) so it costs ≤24 writes/user/day. Unlike
--    last_seen_at (login + GDPR display-name refresh), this means "used the app".
ALTER TABLE users ADD COLUMN last_active_at TEXT;
