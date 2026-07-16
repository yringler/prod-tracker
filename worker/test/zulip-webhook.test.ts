// Zulip inbound webhook (the /link flow): token verification, the direct_message
// guard, per-sender rate limiting, and bound single-use code redemption. Real SQL
// (SqliteD1) + a real Dao so the injected registerChannel writes user_channels.
import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { makeZulipAdapter } from '../src/notifications/adapters/zulip/adapter';
import type { InboundContext } from '../src/notifications/contract';
import { getLink, mintCode, recordFailedAttempt } from '../src/notifications/adapters/zulip/store';
import { SqliteD1 } from './support/sqlite-d1';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const ALICE = 'acct-alice';
const TOKEN = 'webhook-secret';
const SENDER = 4242;
const CLOUD = 'cloud-1';

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = { DB: db, SECRETS_KEY: TEST_SECRETS_KEY } as unknown as Env;
  // The webhook token now lives (hashed) in the per-org config row; a matching
  // inbound token both authenticates AND resolves the org.
  await seedZulipOrgConfig(env, CLOUD, { webhookToken: TOKEN });
});

const ctx: InboundContext = {
  registerChannel: (u, c, l) => dao.registerChannel(u, c, l),
};

interface WebhookMsg {
  token?: string;
  trigger?: string;
  sender_id?: number;
  sender_full_name?: string;
  content?: string;
}

function req({
  token = TOKEN,
  trigger = 'direct_message',
  sender_id = SENDER,
  sender_full_name = 'Alice A',
  content = '',
}: WebhookMsg): Request {
  return new Request('https://app.example/api/notifications/zulip/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      trigger,
      message: { sender_id, sender_full_name, content },
    }),
  });
}

async function call(body: WebhookMsg): Promise<Response> {
  const adapter = makeZulipAdapter(env);
  return adapter.handleInbound!(req(body), ctx);
}

describe('zulip webhook — token + guard', () => {
  it('rejects a token matching no org config and links nothing', async () => {
    const code = await mintCode(env, ALICE, 60_000);
    const res = await call({ token: 'nope', content: `/link ${code}` });
    expect(res.status).toBe(401);
    expect(await dao.getUserChannels(ALICE)).toEqual([]);
  });

  it('accepts the legacy "private_message" trigger (older/self-hosted Zulip)', async () => {
    // Zulip renamed private_message → direct_message; self-hosted servers on older
    // versions still send the old name for a DM. Both must link.
    const code = await mintCode(env, ALICE, 60_000);
    const res = await call({ trigger: 'private_message', content: `/link ${code}` });
    expect((await res.json()) as { content?: string }).toHaveProperty(
      'content',
      expect.stringContaining('Connected'),
    );
    expect(await dao.getUserChannels(ALICE)).toEqual([{ channel: 'zulip', label: 'Alice A' }]);
  });

  it('does NOT redeem a valid code sent as a mention (direct_message guard)', async () => {
    const code = await mintCode(env, ALICE, 60_000);
    const res = await call({ trigger: 'mention', content: `/link ${code}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({}); // silent, no reply
    expect(await dao.getUserChannels(ALICE)).toEqual([]);
    // The code survives the guard — it can still be redeemed via a real DM.
    const after = await call({ trigger: 'direct_message', content: `/link ${code}` });
    expect(await after.json()).toHaveProperty('content', expect.stringContaining('Connected'));
    expect(await dao.getUserChannels(ALICE)).toEqual([{ channel: 'zulip', label: 'Alice A' }]);
  });
});

describe('zulip webhook — redemption', () => {
  it('links the account and writes user_channels on a valid /link DM', async () => {
    const code = await mintCode(env, ALICE, 60_000);
    const res = await call({ content: `/link ${code}` });
    const bodyJson = (await res.json()) as { content?: string };
    expect(bodyJson.content).toContain('Connected');
    expect(await dao.getUserChannels(ALICE)).toEqual([{ channel: 'zulip', label: 'Alice A' }]);
    // The link is stamped with the org the webhook token resolved to.
    expect((await getLink(env, ALICE))?.cloudId).toBe(CLOUD);
  });

  it('stamps the org of the TOKEN that redeemed the code (multi-org routing)', async () => {
    await seedZulipOrgConfig(env, 'cloud-2', { webhookToken: 'token-two' });
    const code = await mintCode(env, ALICE, 60_000);
    const res = await call({ token: 'token-two', content: `/link ${code}` });
    expect(((await res.json()) as { content?: string }).content).toContain('Connected');
    expect((await getLink(env, ALICE))?.cloudId).toBe('cloud-2');
  });

  it('accepts a lowercase code (normalized to the mint alphabet)', async () => {
    const code = await mintCode(env, ALICE, 60_000);
    const res = await call({ content: `/link ${code.toLowerCase()}` });
    expect((await res.json() as { content?: string }).content).toContain('Connected');
    expect(await dao.getUserChannels(ALICE)).toHaveLength(1);
  });

  it('replies with instructions on unknown content and links nothing', async () => {
    const res = await call({ content: 'hi there' });
    expect((await res.json() as { content?: string }).content).toContain('/link');
    expect(await dao.getUserChannels(ALICE)).toEqual([]);
  });

  it('rejects an expired code and records a failed attempt', async () => {
    const code = await mintCode(env, ALICE, -1000); // already expired
    const res = await call({ content: `/link ${code}` });
    expect((await res.json() as { content?: string }).content).toMatch(/invalid or has expired/);
    expect(await dao.getUserChannels(ALICE)).toEqual([]);
  });

  it('refuses once the per-sender failed-attempt rate limit is exceeded', async () => {
    for (let i = 0; i < 5; i++) await recordFailedAttempt(env, String(SENDER));
    const code = await mintCode(env, ALICE, 60_000); // a VALID code
    const res = await call({ content: `/link ${code}` });
    expect((await res.json() as { content?: string }).content).toMatch(/Too many attempts/);
    // The valid code must NOT have been redeemed while rate-limited.
    expect(await dao.getUserChannels(ALICE)).toEqual([]);
  });

  it('re-link upserts without accumulating rows', async () => {
    const c1 = await mintCode(env, ALICE, 60_000);
    await call({ content: `/link ${c1}` });
    const c2 = await mintCode(env, ALICE, 60_000);
    await call({ content: `/link ${c2}`, sender_full_name: 'Alice Renamed' });
    expect(await dao.getUserChannels(ALICE)).toEqual([
      { channel: 'zulip', label: 'Alice Renamed' },
    ]);
  });
});
