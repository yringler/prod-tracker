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
