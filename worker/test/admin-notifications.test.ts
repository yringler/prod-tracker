// Admin notification-config routes: the vendor-agnostic list (descriptors with
// requestedFields + per-org configured flag, never stored values) and the
// configure endpoint forwarding to the adapter's configureOrg. Handlers called
// directly, like notifications-routes.test.ts; the requireAdmin gate itself is
// placement in index.ts's /api/admin/ block, same as every other admin route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminChannelConfigResponse } from '@shared/notifications';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import { configureChannel, listChannelConfigs } from '../src/routes/admin';
import { SqliteD1 } from './support/sqlite-d1';
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
    // Email is env-based (no configureOrg/requestedFields) → excluded.
    expect(body.channels.map((c) => c.descriptor.channel)).toEqual(['zulip']);
    const zulip = body.channels[0]!;
    expect(zulip.descriptor.requestedFields).toEqual(['site', 'botEmail', 'apiKey', 'webhookToken']);
    expect(zulip.configured).toBe(true);
    // Write-only: nothing but descriptor + flag crosses the wire.
    expect(Object.keys(zulip).sort()).toEqual(['configured', 'descriptor']);
  });

  it("reports configured=false for an org that hasn't set the channel up", async () => {
    await seedZulipOrgConfig(env, CLOUD);
    const res = await listChannelConfigs(ctxFor('cloud-other'));
    const body = (await res.json()) as AdminChannelConfigResponse;
    expect(body.channels[0]!.configured).toBe(false);
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

    const list = (await (await listChannelConfigs(ctxFor(CLOUD))).json()) as AdminChannelConfigResponse;
    expect(list.channels[0]!.configured).toBe(true);
    // Scoped to the admin's org, not globally.
    const other = (await (await listChannelConfigs(ctxFor('cloud-2'))).json()) as AdminChannelConfigResponse;
    expect(other.channels[0]!.configured).toBe(false);
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

  it('404s a channel without org config (email) and an unknown channel', async () => {
    expect((await configureChannel(configureReq(FIELDS), ctxFor(CLOUD), 'email')).status).toBe(404);
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
