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

const CLOUD = 'cloud-1';
const ALICE = 'acct-alice';
const silent = log.child({ quiet: true });

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    APP_ORIGIN: 'https://app.example',
    EMAIL_FROM: 'notify@org.com',
    EMAIL_API_KEY: 'ek',
    // Zulip vars so its adapter constructs cleanly when the registry builds it.
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

  it('deliver is not_linked before save, delivered after, with a masked status label', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = makeEmailAdapter(env);

    expect(await adapter.deliver({ userId: ALICE, payload, idempotencyKey: 'k' })).toEqual({
      status: 'not_linked',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await saveEmail(env, ALICE, 'alice@example.com');
    expect(await adapter.getStatus(ALICE)).toEqual({ linked: true, label: 'a****@example.com' });
    expect(await adapter.deliver({ userId: ALICE, payload, idempotencyKey: 'k' })).toEqual({
      status: 'delivered',
    });
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
    await saveZulipLink(env, ALICE, '4242', 'Alice A');

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
