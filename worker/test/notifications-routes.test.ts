// App-side notification routes: self-scoped channel list, setup 404 on an unknown
// channel, and unlink clearing BOTH the adapter link and the app-owned user_channels
// row. Real SQL (SqliteD1); channels resolved through the real registry (Zulip).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import {
  beginChannelSetup,
  channelStatus,
  listChannels,
  sendTestNotification,
  setChannelEnabled,
  unlinkChannel,
} from '../src/routes/notifications';
import { getLink, saveLink } from '../src/notifications/adapters/zulip/store';
import type { ChannelListResponse, SetChannelEnabledResponse } from '@shared/notifications';
import { SqliteD1 } from './support/sqlite-d1';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const CLOUD = 'cloud-1';
const ALICE = 'acct-alice';
const BOB = 'acct-bob';

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    EMAIL_FROM: 'notify@org.com',
    EMAIL_API_KEY: 'ek',
    SECRETS_KEY: TEST_SECRETS_KEY,
  } as unknown as Env;
  // Zulip is org-configured (DB rows), not env-configured, since 0008.
  await seedZulipOrgConfig(env, CLOUD);
});

function ctxFor(accountId: string): AuthedCtx {
  return { accountId, cloudId: CLOUD, sid: 'sid', dao, env };
}

function enabledReq(enabled: boolean): Request {
  return new Request('https://app.example/api/notifications/zulip/enabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

async function listOf(ctx: AuthedCtx): Promise<ChannelListResponse> {
  return (await (await listChannels(ctx)).json()) as ChannelListResponse;
}

describe('notification routes', () => {
  it('lists each channel descriptor + the authed account status only', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await saveLink(env, BOB, '9999', 'Bob B', CLOUD);

    const res = await listChannels(ctxFor(ALICE));
    const body = (await res.json()) as ChannelListResponse;
    const zulip = body.channels.find((c) => c.descriptor.channel === 'zulip');
    expect(zulip?.status).toEqual({ linked: true, label: 'Alice A' }); // Alice's, never Bob's
    // Every registered channel is described; email is present but not linked here.
    expect(body.channels.map((c) => c.descriptor.channel).sort()).toEqual(['email', 'zulip']);
    const email = body.channels.find((c) => c.descriptor.channel === 'email');
    expect(email?.status).toEqual({ linked: false });
  });

  it('skips a failing adapter instead of blanking the whole list', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    // Simulate the real-world cause of "no channels": an unmigrated D1 where an
    // adapter's table is missing, so its getStatus throws. The route must degrade
    // to the healthy channels, not 500 the whole list.
    await env.DB.prepare('DROP TABLE zulip_links').run();

    const res = await listChannels(ctxFor(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChannelListResponse;
    const names = body.channels.map((c) => c.descriptor.channel);
    expect(names).toContain('email'); // healthy channel still listed
    expect(names).not.toContain('zulip'); // failing channel skipped, not fatal
  });

  it('hides an unconfigured channel and 404s its setup', async () => {
    // Drop the email transport secret: the channel can't deliver, so it must not be
    // advertised in the list, and its setup routes must 404 (no connecting a channel
    // that can never send).
    const unconfigured = { ...env, EMAIL_API_KEY: '', EMAIL_FROM: '' } as unknown as Env;
    const uctx: AuthedCtx = { accountId: ALICE, cloudId: CLOUD, sid: 'sid', dao, env: unconfigured };

    const res = await listChannels(uctx);
    const body = (await res.json()) as ChannelListResponse;
    const names = body.channels.map((c) => c.descriptor.channel);
    expect(names).toContain('zulip'); // still configured
    expect(names).not.toContain('email'); // secret missing → hidden

    const setup = await beginChannelSetup(uctx, 'email');
    expect(setup.status).toBe(404);
  });

  it('hides zulip for an org WITHOUT config and 404s its setup (per-org gating)', async () => {
    const octx: AuthedCtx = { accountId: ALICE, cloudId: 'cloud-other', sid: 'sid', dao, env };

    const res = await listChannels(octx);
    const names = ((await res.json()) as ChannelListResponse).channels.map(
      (c) => c.descriptor.channel,
    );
    expect(names).toContain('email'); // legacy env fallback still covers every org
    expect(names).not.toContain('zulip'); // no config row for cloud-other → hidden

    const setup = await beginChannelSetup(octx, 'zulip');
    expect(setup.status).toBe(404);
  });

  it('reports not-linked for an account with no link', async () => {
    const res = await channelStatus(ctxFor(ALICE), 'zulip');
    expect(await res.json()).toEqual({ linked: false });
  });

  it('404s beginChannelSetup on an unknown channel', async () => {
    const res = await beginChannelSetup(ctxFor(ALICE), 'telegram');
    expect(res.status).toBe(404);
  });

  it('begins setup for a known channel', async () => {
    const res = await beginChannelSetup(ctxFor(ALICE), 'zulip');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completion: string };
    expect(body.completion).toBe('poll');
  });

  it('unlink clears both the adapter link and the user_channels row', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    const res = await unlinkChannel(ctxFor(ALICE), 'zulip');
    expect(res.status).toBe(200);
    expect(await getLink(env, ALICE)).toBeNull();
    expect(await dao.getUserChannels(ALICE)).toEqual([]);
  });

  it('lists enabled=false until the user opts in, then true', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    // Linked but never opted in: the two are orthogonal.
    let zulip = (await listOf(ctxFor(ALICE))).channels.find((c) => c.descriptor.channel === 'zulip');
    expect(zulip!.enabled).toBe(false);
    expect(zulip!.status).toEqual({ linked: true, label: 'Alice A' });

    await setChannelEnabled(enabledReq(true), ctxFor(ALICE), 'zulip');
    zulip = (await listOf(ctxFor(ALICE))).channels.find((c) => c.descriptor.channel === 'zulip');
    expect(zulip!.enabled).toBe(true);
  });

  it('a pre-0013 link (row exists, never toggled) still reads enabled', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    // The shape 0013 migrates INTO: a row written before the column existed, so the
    // column DEFAULT decides. That default is 1 — an existing user who had linked a
    // channel must not be silently muted by the upgrade.
    await db
      .prepare(
        `INSERT INTO user_channels (account_id, channel, label, linked_at)
         VALUES (?, 'zulip', 'Alice A', ?)`,
      )
      .bind(ALICE, new Date().toISOString())
      .run();

    const zulip = (await listOf(ctxFor(ALICE))).channels.find(
      (c) => c.descriptor.channel === 'zulip',
    );
    expect(zulip!.enabled).toBe(true);
  });

  it('channel prefs read failure degrades to off, not a 500', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    vi.spyOn(dao, 'listChannelPrefs').mockRejectedValue(new Error('no such column: enabled'));

    const res = await listChannels(ctxFor(ALICE));
    expect(res.status).toBe(200);
    const zulip = ((await res.json()) as ChannelListResponse).channels.find(
      (c) => c.descriptor.channel === 'zulip',
    );
    expect(zulip).toBeDefined();
    expect(zulip!.enabled).toBe(false);
  });

  it('toggling off MUTES without unlinking (the address is remembered)', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    const res = await setChannelEnabled(enabledReq(false), ctxFor(ALICE), 'zulip');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      status: { linked: true, label: 'Alice A' },
    });
    // The identity survives; only delivery is suppressed.
    expect(await getLink(env, ALICE)).not.toBeNull();
    expect(await dao.getUserChannels(ALICE)).toEqual([]); // delivery view
    expect(await dao.listChannelPrefs(ALICE)).toEqual([
      { channel: 'zulip', label: 'Alice A', enabled: false },
    ]);

    // …and back on, with no re-do of the /link dance.
    await setChannelEnabled(enabledReq(true), ctxFor(ALICE), 'zulip');
    expect(await dao.getUserChannels(ALICE)).toEqual([{ channel: 'zulip', label: 'Alice A' }]);
  });

  it('enabling before any identity exists is allowed, and says so in one round-trip', async () => {
    const res = await setChannelEnabled(enabledReq(true), ctxFor(ALICE), 'zulip');
    const body = (await res.json()) as SetChannelEnabledResponse;
    expect(body).toEqual({ enabled: true, status: { linked: false } });
  });

  it("404s enabling a channel the ORG hasn't configured", async () => {
    const octx: AuthedCtx = { accountId: ALICE, cloudId: 'cloud-other', sid: 'sid', dao, env };
    expect((await setChannelEnabled(enabledReq(true), octx, 'zulip')).status).toBe(404);
    expect((await setChannelEnabled(enabledReq(true), ctxFor(ALICE), 'telegram')).status).toBe(404);
  });

  it('rejects a non-boolean enabled', async () => {
    const bad = new Request('https://app.example/api/notifications/zulip/enabled', {
      method: 'PUT',
      body: 'not json',
    });
    expect((await setChannelEnabled(bad, ctxFor(ALICE), 'zulip')).status).toBe(400);
  });

  it('404s setup (not 500) when isConfigured throws (unmigrated config table)', async () => {
    await env.DB.prepare('DROP TABLE zulip_org_config').run(); // hasOrgConfig now throws
    const res = await beginChannelSetup(ctxFor(ALICE), 'zulip');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/notifications/test — self-serve delivery check', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers to a linked channel and reports its status', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    // A registered app-owned channel + the adapter's own link row (both required: the
    // route reads user_channels, the adapter reads its zulip_links address).
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);

    const res = await sendTestNotification(ctxFor(ALICE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      channels: [{ channel: 'zulip', status: 'delivered' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the outbound send path actually ran
  });

  it('reports not_linked when the app channel exists but the adapter has no address', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A'); // no saveLink → no zulip address

    const res = await sendTestNotification(ctxFor(ALICE));
    expect(await res.json()).toEqual({
      ok: true,
      channels: [{ channel: 'zulip', status: 'not_linked' }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty result set for an account with no channels', async () => {
    const res = await sendTestNotification(ctxFor(ALICE));
    expect(await res.json()).toEqual({ ok: true, channels: [] });
  });

  it('skips a channel the user has disabled', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.setChannelEnabled(ALICE, 'zulip', false);

    const res = await sendTestNotification(ctxFor(ALICE));
    expect(await res.json()).toEqual({ ok: true, channels: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivers under the session org (deliver receives orgId = ctx.cloudId)', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');
    // A pre-0008 link (NULL cloud_id): only the request's orgId can name the org,
    // and it resolves CLOUD's admin-provisioned site.
    await db
      .prepare(
        `INSERT INTO zulip_links (account_id, zulip_user_id, full_name, linked_at, cloud_id)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(ALICE, '4242', 'Alice A', new Date().toISOString())
      .run();
    await seedZulipOrgConfig(env, 'cloud-2', { site: 'https://two.zulipchat.com', webhookToken: 't2' });

    await sendTestNotification(ctxFor(ALICE));
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://org.zulipchat.com/api/v1/messages',
    );
  });
});
