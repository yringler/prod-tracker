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

const ALICE = 'acct-alice';
const ZULIP_UID = '4242';

let db: SqliteD1;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  env = {
    DB: db,
    ZULIP_SITE: 'https://org.zulipchat.com',
    ZULIP_BOT_EMAIL: 'notify-bot@org.zulipchat.com',
    ZULIP_API_KEY: 'apikey',
    ZULIP_WEBHOOK_TOKEN: 'tok',
  } as unknown as Env;
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
    const r = await adapter.deliver({ userId: ALICE, payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'not_linked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a form-encoded private (direct) message with Basic auth after linking', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await saveLink(env, ALICE, ZULIP_UID, 'Alice A');

    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, payload, idempotencyKey: 'k' });
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
    await saveLink(env, ALICE, ZULIP_UID, 'Alice');
    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: true });
  });

  it('maps a 400 to failed{retryable:false}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad' }) as unknown as Response),
    );
    await saveLink(env, ALICE, ZULIP_UID, 'Alice');
    const adapter = makeZulipAdapter(env);
    const r = await adapter.deliver({ userId: ALICE, payload, idempotencyKey: 'k' });
    expect(r).toEqual({ status: 'failed', retryable: false });
  });
});

describe('zulip adapter — status / unlink / setup', () => {
  it('getStatus flips false -> true and unlink clears it', async () => {
    const adapter = makeZulipAdapter(env);
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: false });

    await saveLink(env, ALICE, ZULIP_UID, 'Alice A');
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: true, label: 'Alice A' });

    await adapter.unlink(ALICE);
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: false });
  });

  it('isConfigured requires the full site/bot/api/webhook secret set', () => {
    expect(makeZulipAdapter(env).isConfigured!()).toBe(true);
    for (const missing of ['ZULIP_SITE', 'ZULIP_BOT_EMAIL', 'ZULIP_API_KEY', 'ZULIP_WEBHOOK_TOKEN']) {
      const partial = { ...env, [missing]: '' } as unknown as Env;
      expect(makeZulipAdapter(partial).isConfigured!()).toBe(false);
    }
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
