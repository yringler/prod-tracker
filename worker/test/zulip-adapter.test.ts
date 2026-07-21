// Zulip adapter: outbound delivery + setup/status/unlink, against real SQL (SqliteD1)
// with a stubbed fetch. Mirrors pd-report.test.ts's fetch-stub style. Asserts the
// form-urlencoded, Basic-auth, type=private wire shape (the backward-compatible message
// type older self-hosted servers require) and the not_linked/retryable contract — and
// that vendor content is composed only inside the adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { makeZulipAdapter } from '../src/notifications/adapters/zulip/adapter';
import { mintCode, redeemCode, saveLink } from '../src/notifications/adapters/zulip/store';
import type { NotificationPayload } from '../src/notifications/contract';
import { SqliteD1 } from './support/sqlite-d1';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const ALICE = 'acct-alice';
const ZULIP_UID = '4242';
const CLOUD = 'cloud-1';

let db: SqliteD1;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1();
  env = { DB: db, SECRETS_KEY: TEST_SECRETS_KEY } as unknown as Env;
  // Per-org config (site/botEmail/apiKey encrypted; webhook token hashed) —
  // replaces the pre-0008 env-based ZULIP_* settings.
  await seedZulipOrgConfig(env, CLOUD);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const payload: NotificationPayload = {
  title: 'A ticket is waiting',
  body: 'ABC-1 — Do the thing',
  deepLink: 'https://app.example/tracker?pending=cloud:ABC-1:9',
  urgency: 'normal',
};

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response);
}

describe('zulip adapter — deliver', () => {
  it('returns not_linked before a link exists', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'not_linked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a form-encoded private (direct) message with Basic auth after linking', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await saveLink(env, ALICE, ZULIP_UID, 'Alice A', CLOUD);

    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'delivered' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://org.zulipchat.com/api/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Authorization).toBe('Basic ' + btoa('notify-bot@org.zulipchat.com:apikey'));

    const body = new URLSearchParams(init.body as string);
    expect(body.get('type')).toBe('private');
    // Numeric user id goes out as a JSON integer (`[4242]`, not `["4242"]`); Zulip reads
    // string entries in `to` as email addresses ("Invalid email '4242'"), integers as ids.
    expect(body.get('to')).toBe(JSON.stringify([Number(ZULIP_UID)]));
    // The vendor string is composed inside the adapter (render.ts), not by the app.
    expect(body.get('content')).toContain('ABC-1 — Do the thing');
    expect(body.get('content')).toContain(payload.deepLink);
  });

  it('maps a 500 to failed{retryable:true}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }) as unknown as Response),
    );
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', CLOUD);
    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: true });
  });

  it('maps a 400 to failed{retryable:false}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad' }) as unknown as Response),
    );
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', CLOUD);
    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: false });
  });
});

describe('zulip adapter — per-org deliver routing', () => {
  it('routes the send through the LINK org, not any other config', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await seedZulipOrgConfig(env, 'cloud-2', {
      site: 'https://two.zulipchat.com',
      botEmail: 'bot2@two.zulipchat.com',
      apiKey: 'apikey-2',
      webhookToken: 'tok-2',
    });
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', 'cloud-2');

    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'delivered' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://two.zulipchat.com/api/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic ' + btoa('bot2@two.zulipchat.com:apikey-2'));
  });

  it("req.orgId WINS over the link's own cloud_id", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await seedZulipOrgConfig(env, 'cloud-2', {
      site: 'https://two.zulipchat.com',
      botEmail: 'bot2@two.zulipchat.com',
      apiKey: 'apikey-2',
      webhookToken: 'tok-2',
    });
    // Linked under cloud-2, but the reminder is ABOUT cloud-1 — the caller's org
    // decides which admin-provisioned bot sends it.
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', 'cloud-2');

    const r = await makeZulipAdapter(env).deliver({
      userId: ALICE,
      orgId: CLOUD,
      payload,
      idempotencyKey: 'k',
    });
    expect(r).toEqual({ status: 'delivered' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://org.zulipchat.com/api/v1/messages',
    );
  });

  it("refuses to deliver under ANOTHER org's credentials when req.orgId has no config", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await seedZulipOrgConfig(env, 'cloud-2', {
      site: 'https://two.zulipchat.com',
      webhookToken: 'tok-2',
    });
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', 'cloud-2');

    // The reminder is ABOUT cloud-unconfigured, which has un-provisioned Zulip. Its
    // content (issue key, title) must NOT leak into org 2's server under org 2's bot.
    const r = await makeZulipAdapter(env).deliver({
      userId: ALICE,
      orgId: 'cloud-unconfigured',
      payload,
      idempotencyKey: 'k',
    });
    expect(r).toEqual({ status: 'failed', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NULL-org link (pre-0008) + exactly one config: falls back and delivers', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    // Simulate a pre-migration row: cloud_id was backfilled as NULL by ALTER TABLE.
    await db
      .prepare(
        `INSERT INTO zulip_links (account_id, zulip_user_id, full_name, linked_at, cloud_id)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(ALICE, ZULIP_UID, 'Alice', new Date().toISOString())
      .run();

    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'delivered' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://org.zulipchat.com/api/v1/messages');
  });

  it('NULL-org link with TWO configs is ambiguous: failed{retryable:false}, no send', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await seedZulipOrgConfig(env, 'cloud-2', { webhookToken: 'tok-2' });
    await db
      .prepare(
        `INSERT INTO zulip_links (account_id, zulip_user_id, full_name, linked_at, cloud_id)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(ALICE, ZULIP_UID, 'Alice', new Date().toISOString())
      .run();

    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("link to an org with no config: failed{retryable:false}, no send", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', 'cloud-unconfigured');

    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('seeded row but SECRETS_KEY absent: failed{retryable:false}, no send', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', CLOUD); // CLOUD is seeded in beforeEach

    const noKey = { DB: db } as unknown as Env; // SECRETS_KEY missing → can't decrypt
    const adapter = makeZulipAdapter(noKey);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('row sealed under a DIFFERENT SECRETS_KEY: failed{retryable:false}, no send', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await saveLink(env, ALICE, ZULIP_UID, 'Alice', CLOUD); // sealed under TEST_SECRETS_KEY

    const wrongKey = btoa('ABCDEFGHABCDEFGHABCDEFGHABCDEFGH'); // 32 bytes, valid but wrong
    const adapter = makeZulipAdapter({ DB: db, SECRETS_KEY: wrongKey } as unknown as Env);
    const r = await adapter.deliver({ userId: ALICE, orgId: '', payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('zulip adapter — status / unlink / setup', () => {
  it('getStatus flips false -> true and unlink clears it', async () => {
    const adapter = makeZulipAdapter(env);
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: false });

    await saveLink(env, ALICE, ZULIP_UID, 'Alice A', CLOUD);
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: true, label: 'Alice A' });

    await adapter.unlink(ALICE);
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: false });
  });

  it('isConfigured is per-org: true for the configured org, false for others', async () => {
    const adapter = makeZulipAdapter(env);
    expect(await adapter.isConfigured!(CLOUD)).toBe(true);
    expect(await adapter.isConfigured!('cloud-other')).toBe(false);
  });

  it('beginSetup mints a copyable /link command with an expiry', async () => {
    const adapter = makeZulipAdapter(env);
    const instr = await adapter.beginSetup(ALICE);
    expect(instr.completion).toBe('poll');
    const copyable = instr.steps.find((s) => s.kind === 'copyable');
    expect(copyable).toBeDefined();
    if (copyable && copyable.kind === 'copyable') {
      expect(copyable.value).toMatch(/^\/link [A-Z0-9]{6}$/);
      expect(copyable.expiresAt).toBeGreaterThan(Date.now());
    }
  });
});

describe('zulip link codes — redemption', () => {
  it('double-redeem fails: the second redemption returns null', async () => {
    const code = await mintCode(env, ALICE, 60_000);
    expect(await redeemCode(env, code)).toEqual({ accountId: ALICE });
    expect(await redeemCode(env, code)).toBeNull();
  });

  it('race — exactly one winner across concurrent redemptions', async () => {
    const code = await mintCode(env, ALICE, 60_000);
    const [a, b] = await Promise.all([redeemCode(env, code), redeemCode(env, code)]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual({ accountId: ALICE });
  });

  it('expired code fails', async () => {
    const code = await mintCode(env, ALICE, -1);
    expect(await redeemCode(env, code)).toBeNull();
  });
});
