// Per-org Email transport config: validate + live-verify + encrypt on the way in,
// decrypt on the way out. Deliberately mirrors zulip/org-config.ts — store.ts stays
// raw persistence, this module owns the crypto (via ../../secretbox) and the vendor
// verification call. Secrets are write-only: nothing decrypted here ever flows back
// to a client (only `fromAddress`, which the admin UI is allowed to see).

import type { Env } from '../../../env';
import { errFields, log } from '../../../log';
import type { ConfigureOrgResult } from '../../contract';
import { open, seal } from '../../secretbox';
import { getEmailOrgConfig, saveEmailOrgConfig } from './store';

/** What deliver needs to send mail for an org. Encrypted at rest as one JSON blob
 *  in email_org_config.secrets_enc (`fromAddress` is additionally stored in the
 *  clear, since it is the one non-secret provisioning value). */
export interface EmailOrgSecrets {
  apiKey: string;
  fromAddress: string;
}

/** The fields an admin supplies, advertised via the descriptor. Order matters —
 *  the admin UI renders them top-to-bottom, non-secret first. */
export const EMAIL_REQUESTED_FIELDS = ['fromAddress', 'apiKey'];

/** Deliberately loose: we only reject the obviously-not-an-address. Shared by the
 *  admin's From: address and the user's delivery address so both are held to the
 *  same (single) rule. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate admin-entered fields, live-verify the key against the transport, then
 *  encrypt + persist. Every failure path returns a human-readable `error` the admin
 *  UI shows verbatim; nothing is persisted unless verification passed. */
export async function configureEmailOrg(
  env: Env,
  orgId: string,
  fields: Record<string, string>,
  configuredBy: string,
): Promise<ConfigureOrgResult> {
  const fromAddress = (fields['fromAddress'] ?? '').trim();
  const apiKey = (fields['apiKey'] ?? '').trim();

  if (!fromAddress || !apiKey) {
    return { ok: false, error: 'All fields are required: fromAddress, apiKey.' };
  }
  if (!EMAIL_RE.test(fromAddress)) {
    return {
      ok: false,
      error: `"${fromAddress}" is not a valid email address — expected e.g. notify@yourorg.com`,
    };
  }
  if (!env.SECRETS_KEY) {
    // A knowable operator error, not a 500: the master key was never provisioned.
    return {
      ok: false,
      error: 'Server is missing the SECRETS_KEY secret — ask the operator to set it.',
    };
  }

  // Live-verify the API key so a typo'd key is caught NOW, not on the first
  // reminder — the same rationale as Zulip's /users/me probe. /domains is the
  // cheapest authenticated GET on the same transport deliver.ts posts to, and it
  // sends nothing (no mail is emitted by a verification).
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.text()).slice(0, 500);
      } catch {
        // best-effort body; the status alone is still actionable
      }
      // A least-privilege "Sending access" key can POST /emails — all deliver.ts
      // needs — but cannot READ /domains: it answers 401 `restricted_api_key`.
      // That answer PROVES the key is live and authenticated, so treat it as a
      // pass rather than pushing the admin to a full-access key.
      const restricted =
        (res.status === 401 || res.status === 403) && /restricted_api_key/.test(msg);
      if (!restricted) {
        return {
          ok: false,
          error: `The email transport rejected the API key (HTTP ${res.status}): ${msg}`,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach the email transport: ${
        e instanceof Error ? e.message : 'network error'
      }`,
    };
  }

  const secrets: EmailOrgSecrets = { apiKey, fromAddress };
  const secretsEnc = await seal(env.SECRETS_KEY, JSON.stringify(secrets));
  await saveEmailOrgConfig(env, orgId, secretsEnc, fromAddress, configuredBy);
  log.info('email: org configured', { cloudId: orgId });
  return { ok: true };
}

/** Decrypt this org's transport credentials.
 *
 *  BACK-COMPAT HINGE: when the org has no row, we fall back to the legacy
 *  EMAIL_API_KEY / EMAIL_FROM env config (both must be present). That is what lets
 *  an existing deployment keep delivering with zero admin action after this change;
 *  the env vars are deprecated in favour of Admin → Notification channels and will
 *  be removed once every deployment has provisioned per-org. Decrypt failure (e.g.
 *  a rotated SECRETS_KEY) logs and returns null rather than crashing escalation. */
export async function loadEmailSecrets(
  env: Env,
  orgId: string,
): Promise<EmailOrgSecrets | null> {
  const row = await getEmailOrgConfig(env, orgId);
  if (row && env.SECRETS_KEY) {
    try {
      return JSON.parse(await open(env.SECRETS_KEY, row.secretsEnc)) as EmailOrgSecrets;
    } catch (e) {
      log.warn('email: could not decrypt org config (rotated SECRETS_KEY?)', errFields(e));
      return null;
    }
  }
  if (row) return null; // configured, but the key to open it is gone
  if (env.EMAIL_API_KEY && env.EMAIL_FROM) {
    return { apiKey: env.EMAIL_API_KEY, fromAddress: env.EMAIL_FROM };
  }
  return null;
}

/** NON-SECRET metadata for the admin list. `fromAddress` is the ONE public
 *  provisioning value (that's why it's also stored in the clear); the api key stays
 *  inside secrets_enc and must never be added here. */
export async function emailOrgSummary(
  env: Env,
  orgId: string,
): Promise<{
  configuredAt: string;
  configuredBy: string | null;
  summary: Record<string, string>;
} | null> {
  const row = await getEmailOrgConfig(env, orgId);
  if (!row) return null;
  return {
    configuredAt: row.configuredAt,
    configuredBy: row.configuredBy,
    summary: { fromAddress: row.fromAddress },
  };
}
