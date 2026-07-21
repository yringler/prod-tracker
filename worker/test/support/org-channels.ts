// Shared fixtures for per-org notification-channel config. The Zulip half lives in
// ./zulip-org (it predates this file); this adds the Email twin, seeding
// email_org_config the way configureEmailOrg does (seal + saveEmailOrgConfig) minus
// the live transport verification — tests stub fetch separately when they need it.
import type { Env } from '../../src/env';
import { saveEmailOrgConfig } from '../../src/notifications/adapters/email/store';
import { seal } from '../../src/notifications/secretbox';
import { TEST_SECRETS_KEY } from './zulip-org';

export { TEST_SECRETS_KEY };

export async function seedEmailOrgConfig(
  env: Env,
  cloudId: string,
  opts: { apiKey?: string; fromAddress?: string } = {},
): Promise<void> {
  const apiKey = opts.apiKey ?? 'org-key';
  const fromAddress = opts.fromAddress ?? 'notify@org.com';
  const secretsEnc = await seal(TEST_SECRETS_KEY, JSON.stringify({ apiKey, fromAddress }));
  await saveEmailOrgConfig(env, cloudId, secretsEnc, fromAddress, 'test-admin');
}
