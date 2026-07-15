// App-side notification routes: self-scoped channel list, setup 404 on an unknown
// channel, and unlink clearing BOTH the adapter link and the app-owned user_channels
// row. Real SQL (SqliteD1); channels resolved through the real registry (Zulip).
import { beforeEach, describe, expect, it } from 'vitest';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import {
  beginChannelSetup,
  channelStatus,
  listChannels,
  unlinkChannel,
} from '../src/routes/notifications';
import { getLink, saveLink } from '../src/notifications/adapters/zulip/store';
import type { ChannelListResponse } from '@shared/notifications';
import { SqliteD1 } from './support/sqlite-d1';

const CLOUD = 'cloud-1';
const ALICE = 'acct-alice';
const BOB = 'acct-bob';

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    ZULIP_SITE: 'https://org.zulipchat.com',
    ZULIP_BOT_EMAIL: 'notify-bot@org.zulipchat.com',
    ZULIP_API_KEY: 'apikey',
    ZULIP_WEBHOOK_TOKEN: 'tok',
  } as unknown as Env;
});

function ctxFor(accountId: string): AuthedCtx {
  return { accountId, cloudId: CLOUD, sid: 'sid', dao, env };
}

describe('notification routes', () => {
  it('lists each channel descriptor + the authed account status only', async () => {
    await saveLink(env, ALICE, '4242', 'Alice A');
    await saveLink(env, BOB, '9999', 'Bob B');

    const res = await listChannels(ctxFor(ALICE));
    const body = (await res.json()) as ChannelListResponse;
    expect(body.channels).toEqual([
      {
        descriptor: { channel: 'zulip', displayName: 'Zulip' },
        status: { linked: true, label: 'Alice A' }, // Alice's, never Bob's
      },
    ]);
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
    await saveLink(env, ALICE, '4242', 'Alice A');
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    const res = await unlinkChannel(ctxFor(ALICE), 'zulip');
    expect(res.status).toBe(200);
    expect(await getLink(env, ALICE)).toBeNull();
    expect(await dao.getUserChannels(ALICE)).toEqual([]);
  });
});
