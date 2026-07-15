-- Email adapter-owned table. Accessed ONLY by
-- worker/src/notifications/adapters/email/store.ts via env.DB — never by dao.ts
-- (same isolation posture as zulip_*). Present in schema.sql for test/bootstrap
-- parity only; the real guarantee is the eslint wall + env.DB-only access in
-- store.ts. Mirrors worker/src/db/schema.sql.
CREATE TABLE IF NOT EXISTS email_links (
  account_id  TEXT PRIMARY KEY,     -- our Atlassian account id
  email       TEXT NOT NULL,        -- the delivery address (opaque to the app)
  verified_at TEXT NOT NULL         -- ISO UTC; when the address was confirmed
);
