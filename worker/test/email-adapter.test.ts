// Email adapter — the second implementation, validating the abstraction. Its deliver
// path mirrors Zulip's not_linked -> delivered shape; availableChannels() now carries
// both; and escalation falls through a not_linked channel to the next and stops on
// the first delivered — with NO change to escalation logic. Real SQL + stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESCALATION_DELAY_MS } from '@shared/domain';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { escalate } from '../src/cron/escalate';
import { makeEmailAdapter } from '../src/notifications/adapters/email/adapter';
import { saveEmail } from '../src/notifications/adapters/email/store';
import { saveLink as saveZulipLink } from '../src/notifications/adapters/zulip/store';
import { availableChannels } from '../src/notifications/registry';
import type { NotificationPayload } from '../src/notifications/contract';
import { log } from '../src/log';
import { SqliteD1 } from './support/sqlite-d1';
import { seedEmailOrgConfig } from './support/org-channels';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const CLOUD = 'cloud-1';
const ALICE = 'acct-alice';
const silent = log.child({ quiet: true });

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    APP_ORIGIN: 'https://app.example',
    EMAIL_FROM: 'notify@org.com',
    EMAIL_API_KEY: 'ek',
    SECRETS_KEY: TEST_SECRETS_KEY,
  } as unknown as Env;
  // Zulip is per-org DB config since 0008; the fall-through test delivers via it.
  await seedZulipOrgConfig(env, CLOUD);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const payload: NotificationPayload = {
  title: 'A ticket is waiting',
  body: 'ABC-1 — Do the thing',
  deepLink: 'https://app.example/tracker?pending=k',
  urgency: 'normal',
};

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response);
}

async function seedRipePending(accountId: string, pendingId: string): Promise<void> {
  const created = new Date(Date.now() - ESCALATION_DELAY_MS - 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO pending_ratings
         (pending_id, cloud_id, account_id, issue_key, title, url, story_points, to_status, changelog_id, transitioned_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(pendingId, CLOUD, accountId, 'ABC-1', 'Do the thing', 'https://jira/ABC-1', 3, 'Done', '900', created, created)
    .run();
}

describe('email adapter', () => {
  it('registers both channels', () => {
    expect([...availableChannels()].sort()).toEqual(['email', 'zulip']);
  });

  it('isConfigured falls back to the legacy env pair, and needs both halves', async () => {
    expect(await makeEmailAdapter(env).isConfigured!(CLOUD)).toBe(true);
    const noKey = { ...env, EMAIL_API_KEY: '' } as unknown as Env;
    const noFrom = { ...env, EMAIL_FROM: '' } as unknown as Env;
    expect(await makeEmailAdapter(noKey).isConfigured!(CLOUD)).toBe(false);
    expect(await makeEmailAdapter(noFrom).isConfigured!(CLOUD)).toBe(false);
  });

  it('isConfigured is PER-ORG once a row exists (no env fallback needed)', async () => {
    const bare = { ...env, EMAIL_API_KEY: '', EMAIL_FROM: '' } as unknown as Env;
    expect(await makeEmailAdapter(bare).isConfigured!(CLOUD)).toBe(false);
    await seedEmailOrgConfig(bare, CLOUD);
    expect(await makeEmailAdapter(bare).isConfigured!(CLOUD)).toBe(true);
    // A different site on the same deployment is still unconfigured.
    expect(await makeEmailAdapter(bare).isConfigured!('cloud-2')).toBe(false);
  });

  it("deliver uses the org row's creds when present and the env pair when absent", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await saveEmail(env, ALICE, 'alice@example.com');

    // No row → the legacy env fallback (back-compat: existing deployments keep
    // delivering with zero admin action).
    await makeEmailAdapter(env).deliver({ userId: ALICE, orgId: CLOUD, payload, idempotencyKey: 'k' });
    let init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ from: 'notify@org.com' });
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ek');

    // Row present → it wins over env.
    await seedEmailOrgConfig(env, CLOUD, { apiKey: 'org-key', fromAddress: 'from-org@org.com' });
    await makeEmailAdapter(env).deliver({ userId: ALICE, orgId: CLOUD, payload, idempotencyKey: 'k' });
    init = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ from: 'from-org@org.com' });
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer org-key');
  });

  it('a rejected send does not log the recipient address', async () => {
    // The transport echoes the request in its 4xx body, `to` included. Workers Logs
    // are persisted, so the address is redacted before it gets there.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 422,
            text: async () => '{"message":"Invalid `to` field: alice@example.com"}',
          }) as unknown as Response,
      ),
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await saveEmail(env, ALICE, 'alice@example.com');

    await makeEmailAdapter(env).deliver({
      userId: ALICE,
      orgId: CLOUD,
      payload,
      idempotencyKey: 'k',
    });

    const send = warn.mock.calls.find((c) => c[0] === 'email: send rejected');
    expect(send).toBeDefined();
    const body = (send![1] as { body: string }).body;
    expect(body).toContain('[address]');
    expect(body).not.toContain('alice@example.com');
    warn.mockRestore();
  });

  it('routes two orgs independently by the request orgId', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const bare = { ...env, EMAIL_API_KEY: '', EMAIL_FROM: '' } as unknown as Env;
    await saveEmail(bare, ALICE, 'alice@example.com');
    await seedEmailOrgConfig(bare, CLOUD, { apiKey: 'k1', fromAddress: 'one@org.com' });
    await seedEmailOrgConfig(bare, 'cloud-2', { apiKey: 'k2', fromAddress: 'two@org.com' });
    const adapter = makeEmailAdapter(bare);

    await adapter.deliver({ userId: ALICE, orgId: CLOUD, payload, idempotencyKey: 'k' });
    await adapter.deliver({ userId: ALICE, orgId: 'cloud-2', payload, idempotencyKey: 'k' });

    const froms = fetchMock.mock.calls.map(
      (c) => JSON.parse(((c as [string, RequestInit])[1].body as string)).from as string,
    );
    expect(froms).toEqual(['one@org.com', 'two@org.com']);
  });

  it('fails non-retryably (never not_linked) when the org has no transport at all', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const bare = { ...env, EMAIL_API_KEY: '', EMAIL_FROM: '' } as unknown as Env;
    await saveEmail(bare, ALICE, 'alice@example.com');
    expect(
      await makeEmailAdapter(bare).deliver({
        userId: ALICE,
        orgId: CLOUD,
        payload,
        idempotencyKey: 'k',
      }),
    ).toEqual({ status: 'failed', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deliver is not_linked before save, delivered after, with a masked status label', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = makeEmailAdapter(env);

    expect(
      await adapter.deliver({ userId: ALICE, orgId: CLOUD, payload, idempotencyKey: 'k' }),
    ).toEqual({ status: 'not_linked' });
    expect(fetchMock).not.toHaveBeenCalled();

    await saveEmail(env, ALICE, 'alice@example.com');
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: true, label: 'a****@example.com' });
    expect(
      await adapter.deliver({ userId: ALICE, orgId: CLOUD, payload, idempotencyKey: 'k' }),
    ).toEqual({ status: 'delivered' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const sent = JSON.parse(init.body as string) as { to: string; subject: string };
    expect(sent.to).toBe('alice@example.com');
    expect(sent.subject).toBe('A ticket is waiting');
  });

  it('submitSetup validates the address before linking', async () => {
    const adapter = makeEmailAdapter(env);
    expect(await adapter.submitSetup!(ALICE, { fields: { email: 'garbage' } })).toEqual({
      linked: false,
    });
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: false });

    expect(await adapter.submitSetup!(ALICE, { fields: { email: 'alice@example.com' } })).toEqual({
      linked: true,
      label: 'a****@example.com',
    });
  });

  it('escalation falls through a not_linked channel and stops on the first delivered', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await seedRipePending(ALICE, 'p1');
    // Both channels registered; getUserChannels orders email before zulip. Email is
    // NOT linked (no email_links row) → not_linked → fall through to a LINKED zulip.
    await dao.registerChannel(ALICE, 'email', 'a****@example.com');
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');
    await saveZulipLink(env, ALICE, '4242', 'Alice A', CLOUD);

    await escalate(env, dao, silent);

    // Exactly one send — email fell through, zulip delivered, the loop stopped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://org.zulipchat.com/api/v1/messages',
    );
  });

  it('escalation delivers via a linked email channel', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await seedRipePending(ALICE, 'p1');
    await dao.registerChannel(ALICE, 'email', 'a****@example.com');
    await saveEmail(env, ALICE, 'alice@example.com');

    await escalate(env, dao, silent);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://api.resend.com/emails');
  });
});
