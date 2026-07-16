// Per-org Zulip credential logic: validate + live-verify + encrypt on the way in,
// decrypt on the way out. store.ts stays raw persistence; this module owns the
// crypto (via ../../secretbox) and the vendor verification call. Secrets are
// write-only — nothing decrypted here ever flows back to a client.

import type { Env } from '../../../env';
import { errFields, log } from '../../../log';
import type { ConfigureOrgResult } from '../../contract';
import { open, seal, sha256Hex } from '../../secretbox';
import { getOrgSecretsEnc, saveOrgConfig, soleOrgConfig } from './store';

/** What deliver/webhook need to talk to a Zulip org. Encrypted at rest as one
 *  JSON blob in zulip_org_config.secrets_enc. */
export interface ZulipOrgSecrets {
  site: string; // e.g. https://yourorg.zulipchat.com — no trailing slash
  botEmail: string;
  apiKey: string;
}

/** The write-only fields an admin supplies, advertised via the descriptor. */
export const ZULIP_REQUESTED_FIELDS = ['site', 'botEmail', 'apiKey', 'webhookToken'];

/** Validate admin-entered fields, live-verify the bot creds against Zulip, then
 *  encrypt + persist. Every failure path returns a human-readable `error` the
 *  admin UI shows verbatim; nothing is persisted unless verification passed. */
export async function configureZulipOrg(
  env: Env,
  orgId: string,
  fields: Record<string, string>,
  configuredBy: string,
): Promise<ConfigureOrgResult> {
  const site = (fields['site'] ?? '').trim().replace(/\/+$/, '');
  const botEmail = (fields['botEmail'] ?? '').trim();
  const apiKey = (fields['apiKey'] ?? '').trim();
  const webhookToken = (fields['webhookToken'] ?? '').trim();

  if (!site || !botEmail || !apiKey || !webhookToken) {
    return {
      ok: false,
      error: 'All fields are required: site, botEmail, apiKey, webhookToken.',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(site);
  } catch {
    return { ok: false, error: `"${site}" is not a valid URL — expected e.g. https://yourorg.zulipchat.com` };
  }
  const isLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && !isLocalhost) {
    return {
      ok: false,
      error: `Site must use https:// — bot credentials are sent as HTTP Basic auth and would go over the wire in cleartext (got "${site}").`,
    };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `Site must be an https URL, got "${parsed.protocol}//".` };
  }
  if (!env.SECRETS_KEY) {
    // A knowable operator error, not a 500: the master key was never provisioned.
    return {
      ok: false,
      error: 'Server is missing the SECRETS_KEY secret — ask the operator to set it.',
    };
  }

  // Live-verify the bot credentials so a typo'd key is caught NOW, not on the
  // first reminder. /users/me is the cheapest authenticated Zulip endpoint.
  try {
    const res = await fetch(`${site}/api/v1/users/me`, {
      headers: { Authorization: 'Basic ' + btoa(`${botEmail}:${apiKey}`) },
    });
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.text()).slice(0, 500);
      } catch {
        // best-effort body; the status alone is still actionable
      }
      return { ok: false, error: `Zulip rejected the credentials (HTTP ${res.status}): ${msg}` };
    }
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach ${site}: ${e instanceof Error ? e.message : 'network error'}`,
    };
  }

  const secrets: ZulipOrgSecrets = { site, botEmail, apiKey };
  const secretsEnc = await seal(env.SECRETS_KEY, JSON.stringify(secrets));
  const tokenHash = await sha256Hex(webhookToken);
  try {
    await saveOrgConfig(env, orgId, secretsEnc, tokenHash, configuredBy);
  } catch (e) {
    // The unique index on webhook_token_hash: the token routes inbound webhooks
    // to an org, so two orgs can't share one.
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      return { ok: false, error: 'That webhook token is already in use by another site.' };
    }
    throw e;
  }
  log.info('zulip: org configured', { cloudId: orgId });
  return { ok: true };
}

/** Decrypt the credentials for a link's org. NULL `linkCloudId` (a pre-0008 link)
 *  falls back to the sole config row — correct for a single-org deployment,
 *  ambiguous (→ null) once a second org configures. Decrypt failure (e.g. a
 *  rotated SECRETS_KEY) logs and returns null rather than crashing escalation. */
export async function loadOrgSecrets(
  env: Env,
  linkCloudId: string | null,
): Promise<ZulipOrgSecrets | null> {
  const enc = linkCloudId
    ? await getOrgSecretsEnc(env, linkCloudId)
    : (await soleOrgConfig(env))?.secretsEnc ?? null;
  if (!enc || !env.SECRETS_KEY) return null;
  try {
    return JSON.parse(await open(env.SECRETS_KEY, enc)) as ZulipOrgSecrets;
  } catch (e) {
    log.warn('zulip: could not decrypt org config (rotated SECRETS_KEY?)', errFields(e));
    return null;
  }
}
