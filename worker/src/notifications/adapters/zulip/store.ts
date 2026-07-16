// All Zulip adapter-owned persistence. This is the ONLY module that touches the
// zulip_* tables, and it does so via env.DB — never through the app's dao (the
// eslint wall forbids importing dao/registry/routes/cron). Keeping vendor
// addresses here is what preserves "the app never learns what a zulip_user_id is."

import type { Env } from '../../../env';

/** Unambiguous alphabet for link codes: no 0/O, no 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export interface ZulipLink {
  zulipUserId: string;
  fullName: string | null;
  /** Org the link was made under (from the webhook token that redeemed the code).
   *  NULL = pre-0008 link; deliver falls back to the sole org config. */
  cloudId: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- Links (account_id -> vendor address) -----------------------------------

export async function saveLink(
  env: Env,
  accountId: string,
  zulipUserId: string,
  fullName: string | null,
  cloudId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO zulip_links (account_id, zulip_user_id, full_name, linked_at, cloud_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       zulip_user_id = excluded.zulip_user_id,
       full_name     = excluded.full_name,
       linked_at     = excluded.linked_at,
       cloud_id      = excluded.cloud_id`,
  )
    .bind(accountId, zulipUserId, fullName, nowIso(), cloudId)
    .run();
}

export async function getLink(env: Env, accountId: string): Promise<ZulipLink | null> {
  const r = await env.DB.prepare(
    `SELECT zulip_user_id, full_name, cloud_id FROM zulip_links WHERE account_id = ?`,
  )
    .bind(accountId)
    .first<{ zulip_user_id: string; full_name: string | null; cloud_id: string | null }>();
  return r
    ? { zulipUserId: r.zulip_user_id, fullName: r.full_name ?? null, cloudId: r.cloud_id ?? null }
    : null;
}

export async function deleteLink(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM zulip_links WHERE account_id = ?`).bind(accountId).run();
}

// --- Per-org config (admin-entered, encrypted at rest) -----------------------
// Raw persistence only: crypto/validation live in org-config.ts. `secretsEnc` is
// an opaque sealed blob here; `webhookTokenHash` is the sha256-hex inbound lookup
// key (the plaintext token is never stored).

/** Upsert one org's config. Throws on a webhook-token-hash collision with ANOTHER
 *  org (unique index) — org-config.ts turns that into a friendly error. */
export async function saveOrgConfig(
  env: Env,
  cloudId: string,
  secretsEnc: string,
  webhookTokenHash: string,
  configuredBy: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO zulip_org_config (cloud_id, secrets_enc, webhook_token_hash, configured_by, configured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id) DO UPDATE SET
       secrets_enc        = excluded.secrets_enc,
       webhook_token_hash = excluded.webhook_token_hash,
       configured_by      = excluded.configured_by,
       configured_at      = excluded.configured_at`,
  )
    .bind(cloudId, secretsEnc, webhookTokenHash, configuredBy, nowIso())
    .run();
}

export async function getOrgSecretsEnc(env: Env, cloudId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT secrets_enc FROM zulip_org_config WHERE cloud_id = ?`)
    .bind(cloudId)
    .first<{ secrets_enc: string }>();
  return r?.secrets_enc ?? null;
}

export async function hasOrgConfig(env: Env, cloudId: string): Promise<boolean> {
  return (await getOrgSecretsEnc(env, cloudId)) !== null;
}

/** Resolve which org an inbound webhook token belongs to. A hit both
 *  authenticates the request AND names the org. */
export async function findOrgByTokenHash(env: Env, hash: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT cloud_id FROM zulip_org_config WHERE webhook_token_hash = ?`,
  )
    .bind(hash)
    .first<{ cloud_id: string }>();
  return r?.cloud_id ?? null;
}

/** NULL-cloud_id link fallback: the sole config row if EXACTLY one org is
 *  configured (the pre-0008 single-org deployment), else null. */
export async function soleOrgConfig(
  env: Env,
): Promise<{ cloudId: string; secretsEnc: string } | null> {
  const { results } = await env.DB.prepare(
    `SELECT cloud_id, secrets_enc FROM zulip_org_config LIMIT 2`,
  ).all<{ cloud_id: string; secrets_enc: string }>();
  const first = results[0];
  if (!first || results.length !== 1) return null;
  return { cloudId: first.cloud_id, secretsEnc: first.secrets_enc };
}

// --- Link codes (bound-at-generation, single-use, TTL'd) --------------------

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Mint a fresh code bound to `accountId` with a TTL. Returns the code string. */
export async function mintCode(env: Env, accountId: string, ttlMs: number): Promise<string> {
  const code = randomCode();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO zulip_link_codes (code, account_id, expires_at, consumed_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(code) DO UPDATE SET account_id = excluded.account_id, expires_at = excluded.expires_at, consumed_at = NULL`,
  )
    .bind(code, accountId, expiresAt)
    .run();
  return code;
}

/** Redeem a code: must be unexpired + unconsumed. Atomically marks it consumed and
 *  returns the bound account. Null if the code is unknown, expired, or already used.
 *  The consume + guards are one statement (conditional CAS) so two concurrent
 *  webhook redemptions of the same code can't both win. */
export async function redeemCode(
  env: Env,
  code: string,
): Promise<{ accountId: string } | null> {
  const now = nowIso();
  const r = await env.DB.prepare(
    `UPDATE zulip_link_codes SET consumed_at = ?
       WHERE code = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING account_id`,
  )
    .bind(now, code, now)
    .first<{ account_id: string }>();
  return r ? { accountId: r.account_id } : null;
}

// --- Failed-attempt rate limiting (per sender_id) ---------------------------

export async function recentFailedAttempts(
  env: Env,
  senderId: string,
  sinceIso: string,
): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM zulip_link_attempts WHERE sender_id = ? AND attempted_at >= ?`,
  )
    .bind(senderId, sinceIso)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function recordFailedAttempt(env: Env, senderId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO zulip_link_attempts (sender_id, attempted_at) VALUES (?, ?)`,
  )
    .bind(senderId, nowIso())
    .run();
}
