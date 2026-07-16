// Shared fixture for per-org Zulip config: seeds zulip_org_config the same way
// configureZulipOrg does (seal + sha256Hex + saveOrgConfig), minus the live
// credential verification — tests stub fetch separately when they need it.
import type { Env } from '../../src/env';
import { saveOrgConfig } from '../../src/notifications/adapters/zulip/store';
import { seal, sha256Hex } from '../../src/notifications/secretbox';

/** base64("0123456789abcdef0123456789abcdef") — exactly 32 bytes. */
export const TEST_SECRETS_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

export interface ZulipOrgSeed {
  site?: string;
  botEmail?: string;
  apiKey?: string;
  webhookToken?: string;
}

export const SEED_DEFAULTS = {
  site: 'https://org.zulipchat.com',
  botEmail: 'notify-bot@org.zulipchat.com',
  apiKey: 'apikey',
  webhookToken: 'tok',
};

export async function seedZulipOrgConfig(
  env: Env,
  cloudId: string,
  opts: ZulipOrgSeed = {},
): Promise<void> {
  const site = opts.site ?? SEED_DEFAULTS.site;
  const botEmail = opts.botEmail ?? SEED_DEFAULTS.botEmail;
  const apiKey = opts.apiKey ?? SEED_DEFAULTS.apiKey;
  const webhookToken = opts.webhookToken ?? SEED_DEFAULTS.webhookToken;
  const secretsEnc = await seal(TEST_SECRETS_KEY, JSON.stringify({ site, botEmail, apiKey }));
  await saveOrgConfig(env, cloudId, secretsEnc, await sha256Hex(webhookToken), 'test-admin');
}
