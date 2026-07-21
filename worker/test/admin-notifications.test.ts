// Admin notification-config routes: the vendor-agnostic list (descriptors with
// requestedFields + per-org configured flag, never stored values) and the
// configure endpoint forwarding to the adapter's configureOrg. Handlers called
// directly, like notifications-routes.test.ts; the requireAdmin gate itself is
// placement in index.ts's /api/admin/ block, same as every other admin route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminChannelConfigItem, AdminChannelConfigResponse } from '@shared/notifications';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import { configureChannel, listChannelConfigs, unconfigureChannel } from '../src/routes/admin';
import { SqliteD1 } from './support/sqlite-d1';
import { seedEmailOrgConfig } from './support/org-channels';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const CLOUD = 'cloud-1';
const ADMIN = 'acct-admin';

const FIELDS = {
  site: 'https://org.zulipchat.com',
  botEmail: 'notify-bot@org.zulipchat.com',
  apiKey: 'apikey',
  webhookToken: 'tok',
};

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    EMAIL_FROM: 'notify@org.com',
    EMAIL_API_KEY: 'ek',
    SECRETS_KEY: TEST_SECRETS_KEY,
  } as unknown as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctxFor(cloudId: string): AuthedCtx {
  return { accountId: ADMIN, cloudId, sid: 'sid', dao, env };
}

/** The list is keyed by channel now that email also takes per-org config. */
async function listByChannel(cloudId: string): Promise<Record<string, AdminChannelConfigItem>> {
  const body = (await (await listChannelConfigs(ctxFor(cloudId))).json()) as AdminChannelConfigResponse;
  return Object.fromEntries(body.channels.map((c) => [c.descriptor.channel, c]));
}

function configureReq(fields: Record<string, string>): Request {
  return new Request('https://app.example/api/admin/notifications/zulip/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

describe('GET /api/admin/notifications/channels', () => {
  it('lists only org-configurable channels, with requestedFields and the org flag', async () => {
    await seedZulipOrgConfig(env, CLOUD);

    const res = await listChannelConfigs(ctxFor(CLOUD));
    const body = (await res.json()) as AdminChannelConfigResponse;
    // Email is admin-provisioned since 0013, so it now passes the configureOrg
    // filter and appears alongside Zulip.
    expect(body.channels.map((c) => c.descriptor.channel).sort()).toEqual(['email', 'zulip']);
    const zulip = (await listByChannel(CLOUD))['zulip']!;
    expect(zulip.descriptor.requestedFields).toEqual(['site', 'botEmail', 'apiKey', 'webhookToken']);
    expect(zulip.configured).toBe(true);
    // Write-only: only the descriptor, the flag, and the adapter-declared
    // non-secret echo cross the wire.
    expect(Object.keys(zulip).sort()).toEqual([
      'configured',
      'configuredAt',
      'configuredBy',
      'descriptor',
      'summary',
    ]);
    expect(zulip.configuredAt).toBeTruthy();
    // The one public field of the sealed box — never the bot email or api key.
    expect(zulip.summary).toEqual({ site: 'https://org.zulipchat.com' });
    expect(JSON.stringify(zulip)).not.toContain('secrets_enc');
    expect(JSON.stringify(zulip)).not.toContain('apikey');
    expect(JSON.stringify(zulip)).not.toContain('notify-bot@');
  });

  it('echoes the email fromAddress but never the api key', async () => {
    await seedEmailOrgConfig(env, CLOUD, { apiKey: 'super-secret', fromAddress: 'a@org.com' });
    const email = (await listByChannel(CLOUD))['email']!;
    expect(email.descriptor.requestedFields).toEqual(['fromAddress', 'apiKey']);
    expect(email.configured).toBe(true);
    expect(email.summary).toEqual({ fromAddress: 'a@org.com' });
    expect(JSON.stringify(email)).not.toContain('super-secret');
  });

  it("reports configured=false for an org that hasn't set the channel up", async () => {
    await seedZulipOrgConfig(env, CLOUD);
    expect((await listByChannel('cloud-other'))['zulip']!.configured).toBe(false);
  });

  it('an env-fallback-only email org lists as configured with no row metadata', async () => {
    // env carries the legacy EMAIL_API_KEY + EMAIL_FROM pair and there is no row:
    // deliverable, but there is nothing site-specific to show or to remove — which
    // is exactly the distinction the admin UI draws off `configuredAt`.
    const email = (await listByChannel(CLOUD))['email']!;
    expect(email.configured).toBe(true);
    expect(email.configuredAt).toBeUndefined();
    expect(email.summary).toBeUndefined();
  });

  it("an unmigrated adapter table doesn't blank the admin list", async () => {
    await seedZulipOrgConfig(env, CLOUD);
    await db.prepare(`DROP TABLE email_org_config`).run();

    const res = await listChannelConfigs(ctxFor(CLOUD));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminChannelConfigResponse;
    expect(body.channels.map((c) => c.descriptor.channel)).toContain('zulip');
  });
});

describe('PUT /api/admin/notifications/:channel/config', () => {
  it('persists valid config for the admin org and flips configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response),
    );

    const res = await configureChannel(configureReq(FIELDS), ctxFor(CLOUD), 'zulip');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect((await listByChannel(CLOUD))['zulip']!.configured).toBe(true);
    // Scoped to the admin's org, not globally.
    expect((await listByChannel('cloud-2'))['zulip']!.configured).toBe(false);
  });

  it("surfaces the adapter's human-readable error as a 400", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: false, status: 401, text: async () => 'Invalid API key' }) as unknown as Response,
      ),
    );

    const res = await configureChannel(configureReq(FIELDS), ctxFor(CLOUD), 'zulip');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid API key');
  });

  it('404s an unknown channel', async () => {
    expect((await configureChannel(configureReq(FIELDS), ctxFor(CLOUD), 'telegram')).status).toBe(
      404,
    );
  });

  it('treats a malformed body as empty fields → validation error, not a throw', async () => {
    const bad = new Request('https://app.example/api/admin/notifications/zulip/config', {
      method: 'PUT',
      body: 'not json',
    });
    const res = await configureChannel(bad, ctxFor(CLOUD), 'zulip');
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/notifications/:channel/config', () => {
  it('flips configured back to false, for THIS org only', async () => {
    await seedZulipOrgConfig(env, CLOUD);
    await seedZulipOrgConfig(env, 'cloud-2', { webhookToken: 'tok-2' });

    const res = await unconfigureChannel(ctxFor(CLOUD), 'zulip');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect((await listByChannel(CLOUD))['zulip']!.configured).toBe(false);
    // The other site is untouched — an admin can only unconfigure their own.
    expect((await listByChannel('cloud-2'))['zulip']!.configured).toBe(true);
  });

  it('removes an email org config (the env fallback then decides availability)', async () => {
    await seedEmailOrgConfig(env, CLOUD, { fromAddress: 'a@org.com' });
    expect((await listByChannel(CLOUD))['email']!.summary).toEqual({ fromAddress: 'a@org.com' });

    await unconfigureChannel(ctxFor(CLOUD), 'email');
    expect((await listByChannel(CLOUD))['email']!.summary).toBeUndefined();
  });

  it('on an org with no config is a 200 no-op', async () => {
    expect((await unconfigureChannel(ctxFor(CLOUD), 'zulip')).status).toBe(200);
    // Idempotent: removing again is still fine.
    expect((await unconfigureChannel(ctxFor(CLOUD), 'zulip')).status).toBe(200);
  });

  it('404s an unknown channel', async () => {
    expect((await unconfigureChannel(ctxFor(CLOUD), 'telegram')).status).toBe(404);
  });
});
