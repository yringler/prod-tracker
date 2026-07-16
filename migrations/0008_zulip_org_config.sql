-- Per-org (cloud_id) Zulip config, admin-entered via the app instead of env
-- secrets. secrets_enc is AES-256-GCM (key: the SECRETS_KEY worker secret) over
-- JSON {site, botEmail, apiKey}; the outgoing-webhook token is stored ONLY as a
-- SHA-256 hex hash — a matching inbound token both authenticates the webhook AND
-- resolves which org the /link belongs to. Adapter-owned: accessed only by
-- worker/src/notifications/adapters/zulip/store.ts via env.DB — never by dao.ts.
-- Mirrors worker/src/db/schema.sql.
CREATE TABLE IF NOT EXISTS zulip_org_config (
  cloud_id           TEXT PRIMARY KEY,   -- the org ("site") this config belongs to
  secrets_enc        TEXT NOT NULL,      -- base64(iv||ciphertext) of {site,botEmail,apiKey}
  webhook_token_hash TEXT NOT NULL,      -- sha256 hex; inbound lookup key, never plaintext
  configured_by      TEXT,               -- admin account_id (audit)
  configured_at      TEXT NOT NULL       -- ISO UTC
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zulip_org_config_token
  ON zulip_org_config(webhook_token_hash);

-- Which org a link belongs to, stamped at link time from the webhook token that
-- redeemed the code. Nullable: pre-0008 links fall back to the sole org config
-- row (see adapters/zulip/org-config.ts loadOrgSecrets).
ALTER TABLE zulip_links ADD COLUMN cloud_id TEXT;
