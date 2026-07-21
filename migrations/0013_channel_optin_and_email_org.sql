-- Per-user channel opt-in + admin-provisioned Email transport.
--
-- Idempotency posture: `ALTER TABLE ... ADD COLUMN` is additive-and-once (exactly
-- as 0005/0008/0011 already do) — wrangler's d1_migrations ledger guarantees a
-- single execution, so re-running the folder never re-applies it.
-- `CREATE TABLE IF NOT EXISTS` is genuinely idempotent.
-- Mirrors worker/src/db/schema.sql.

-- 1) Per-user opt-in. Existing linked rows default to enabled so nobody silently
--    stops receiving reminders on deploy. `enabled` is orthogonal to the identity
--    (the adapter's own link row): "off" mutes the channel without forgetting the
--    address. Enforced centrally in dao.getUserChannels (AND enabled = 1).
ALTER TABLE user_channels ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

-- 2) Email transport becomes admin-provisioned per org, like zulip_org_config.
--    secrets_enc = AES-256-GCM (key: the SECRETS_KEY worker secret) over JSON
--    {apiKey, fromAddress}. Adapter-owned: accessed only by
--    worker/src/notifications/adapters/email/store.ts via env.DB — never dao.ts.
--
--    from_address is stored IN THE CLEAR on purpose — it is the one non-secret
--    provisioning value, and the admin UI must be able to display it (the
--    `summary` echo) without opening the box. apiKey never leaves secrets_enc.
CREATE TABLE IF NOT EXISTS email_org_config (
  cloud_id      TEXT PRIMARY KEY,   -- the org ("site") this config belongs to
  secrets_enc   TEXT NOT NULL,      -- base64(iv||ciphertext) of {apiKey,fromAddress}
  from_address  TEXT NOT NULL,      -- NON-secret, echoed back to the admin UI
  configured_by TEXT,               -- admin account_id (audit)
  configured_at TEXT NOT NULL       -- ISO UTC
);
