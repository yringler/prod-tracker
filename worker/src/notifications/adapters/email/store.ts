// All email adapter-owned persistence. The ONLY module that touches email_links,
// via env.DB — never the app's dao (the eslint wall). Same isolation posture as the
// Zulip store: the delivery address stays inside the adapter.

import type { Env } from '../../../env';

function nowIso(): string {
  return new Date().toISOString();
}

export async function saveEmail(env: Env, accountId: string, email: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_links (account_id, email, verified_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET email = excluded.email, verified_at = excluded.verified_at`,
  )
    .bind(accountId, email, nowIso())
    .run();
}

export async function getEmail(env: Env, accountId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT email FROM email_links WHERE account_id = ?`)
    .bind(accountId)
    .first<{ email: string }>();
  return r ? r.email : null;
}

export async function deleteEmail(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM email_links WHERE account_id = ?`).bind(accountId).run();
}

// --- Per-org transport config (admin-entered, encrypted at rest) --------------
// The email twin of zulip/store.ts's org-config block: raw persistence only —
// crypto/validation/live-verify live in org-config.ts. `secretsEnc` is an opaque
// sealed blob here; `fromAddress` is duplicated in the clear because it is the one
// NON-secret provisioning value the admin UI echoes back.

export interface EmailOrgConfigRow {
  secretsEnc: string;
  fromAddress: string;
  configuredBy: string | null;
  configuredAt: string;
}

export async function saveEmailOrgConfig(
  env: Env,
  cloudId: string,
  secretsEnc: string,
  fromAddress: string,
  configuredBy: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_org_config (cloud_id, secrets_enc, from_address, configured_by, configured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id) DO UPDATE SET
       secrets_enc   = excluded.secrets_enc,
       from_address  = excluded.from_address,
       configured_by = excluded.configured_by,
       configured_at = excluded.configured_at`,
  )
    .bind(cloudId, secretsEnc, fromAddress, configuredBy, nowIso())
    .run();
}

export async function getEmailOrgConfig(
  env: Env,
  cloudId: string,
): Promise<EmailOrgConfigRow | null> {
  const r = await env.DB.prepare(
    `SELECT secrets_enc, from_address, configured_by, configured_at
       FROM email_org_config WHERE cloud_id = ?`,
  )
    .bind(cloudId)
    .first<{
      secrets_enc: string;
      from_address: string;
      configured_by: string | null;
      configured_at: string;
    }>();
  return r
    ? {
        secretsEnc: r.secrets_enc,
        fromAddress: r.from_address,
        configuredBy: r.configured_by ?? null,
        configuredAt: r.configured_at,
      }
    : null;
}

export async function deleteEmailOrgConfig(env: Env, cloudId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM email_org_config WHERE cloud_id = ?`).bind(cloudId).run();
}
