-- Zulip adapter-owned tables. Accessed ONLY by
-- worker/src/notifications/adapters/zulip/store.ts via env.DB — never by dao.ts
-- (so the app never learns a zulip_user_id). They live in schema.sql too, for
-- test/bootstrap parity: a single-D1/single-Worker deploy means the DDL is shared
-- even though only the adapter queries it. The real isolation guarantee is the
-- eslint wall + env.DB-only access in store.ts, not the DDL's location. Mirrors
-- worker/src/db/schema.sql.
CREATE TABLE IF NOT EXISTS zulip_links (
  account_id    TEXT PRIMARY KEY,     -- our Atlassian account id
  zulip_user_id TEXT NOT NULL,        -- the vendor address (opaque to the app)
  full_name     TEXT,                 -- for the opaque display label
  linked_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS zulip_link_codes (
  code        TEXT PRIMARY KEY,       -- unambiguous 6-char alphabet
  account_id  TEXT NOT NULL,          -- BOUND at generation, not redemption
  expires_at  TEXT NOT NULL,          -- ~15 min TTL
  consumed_at TEXT                    -- single-use
);
CREATE TABLE IF NOT EXISTS zulip_link_attempts (
  sender_id    TEXT NOT NULL,         -- zulip sender_id
  attempted_at TEXT NOT NULL          -- for per-sender failed-attempt rate limiting
);
CREATE INDEX IF NOT EXISTS idx_zulip_attempts_sender ON zulip_link_attempts(sender_id, attempted_at);
