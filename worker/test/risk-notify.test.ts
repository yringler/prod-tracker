// The risk board's degraded-notice pass: when an org's boards stop updating, the
// admins who can fix it are told exactly once per episode — per ORG, not per board
// — and told again when it recovers. Real SQL (SqliteD1) + a stubbed global fetch
// (every fetch here is a Zulip DM), mirroring escalate.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { log } from '../src/log';
import { refreshRiskBoards } from '../src/risk/refresh';
import {
  DEGRADED_RENOTIFY_MS,
  mayNotifyDegraded,
  noticeDegradation,
  orgAdmins,
  worstDegraded,
} from '../src/risk/notify';
import {
  claimDegradedNotice,
  getConfig,
  getState,
  markDegraded,
  putConfig,
  recordSuccess,
  riskEraseAccount,
  type RiskBoardState,
  type RiskOrgConfigInput,
} from '../src/risk/store';
import { saveLink } from '../src/notifications/adapters/zulip/store';
import { SqliteD1 } from './support/sqlite-d1';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const CLOUD = 'cloud-1';
const OTHER = 'cloud-2';
const REFRESHER = 'acct-refresher';
const ADMIN = 'acct-admin';
const MEMBER = 'acct-member';
const FOREIGN_ADMIN = 'acct-foreign-admin';
const BOOTSTRAP = 'acct-bootstrap';

const silent = log.child({ quiet: true });
const NOW = Date.parse('2026-07-01T12:00:00.000Z');

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    APP_ORIGIN: 'https://app.example',
    SECRETS_KEY: TEST_SECRETS_KEY,
    BOOTSTRAP_ADMIN_ACCOUNT_ID: BOOTSTRAP,
  } as unknown as Env;
  await seedZulipOrgConfig(env, CLOUD);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function config(over: Partial<RiskOrgConfigInput> = {}): RiskOrgConfigInput {
  return {
    cloudId: CLOUD,
    boards: [{ boardId: 5, name: 'Sites' }],
    cutoffs: null,
    composite: null,
    schedule: null,
    fields: {},
    inProgressStatus: null,
    devStatusAvailable: false,
    refresherAccountId: REFRESHER,
    configuredBy: ADMIN,
    ...over,
  };
}

/** A user who belongs to `cloudId` and has a linked Zulip DM channel. */
async function seedUser(
  accountId: string,
  opts: { admin?: boolean; cloudId?: string; linked?: boolean } = {},
): Promise<void> {
  const cloudId = opts.cloudId ?? CLOUD;
  await dao.upsertUser(accountId, accountId, cloudId);
  await dao.upsertSite(accountId, { cloudId, name: 'Site', siteUrl: 'https://jira' });
  if (opts.admin) await dao.appointAdmin(accountId, null);
  if (opts.linked !== false) {
    await saveLink(env, accountId, `zulip-${accountId}`, accountId, cloudId);
    await dao.registerChannel(accountId, 'zulip', accountId);
  }
}

/** Read the org's live config + board states and run one notice pass. */
async function runNotice(nowMs = NOW, cloudId = CLOUD): Promise<void> {
  const cfg = await getConfig(env, cloudId);
  if (!cfg) throw new Error('no config');
  const states: Array<RiskBoardState | null> = [];
  for (const b of cfg.boards) states.push(await getState(env, cloudId, b.boardId));
  await noticeDegradation(env, dao, cfg, states, silent, nowMs);
}

async function stamp(): Promise<{ at: string | null; reason: string | null }> {
  const cfg = await getConfig(env, CLOUD);
  return { at: cfg?.degradedNotifiedAt ?? null, reason: cfg?.degradedNotifiedReason ?? null };
}

describe('risk notify: pure policy', () => {
  it('mayNotifyDegraded fires on a new episode, a reason change, or once a day', () => {
    const prev = new Date(NOW - 60_000).toISOString();
    expect(mayNotifyDegraded(null, null, 'needs_reauth', NOW)).toBe(true);
    expect(mayNotifyDegraded(prev, 'needs_reauth', 'needs_reauth', NOW)).toBe(false);
    expect(mayNotifyDegraded(prev, 'errors', 'needs_reauth', NOW)).toBe(true);
    const old = new Date(NOW - DEGRADED_RENOTIFY_MS - 1000).toISOString();
    expect(mayNotifyDegraded(old, 'needs_reauth', 'needs_reauth', NOW)).toBe(true);
  });

  it('worstDegraded ranks needs_reauth above errors and nulls a healthy org', () => {
    const s = (degradedReason: 'needs_reauth' | 'errors' | null): RiskBoardState => ({
      cloudId: CLOUD,
      boardId: 1,
      lastViewedAt: null,
      lastRefreshAt: null,
      lastAttemptAt: null,
      failures: 0,
      degradedReason,
    });
    expect(worstDegraded([])).toBeNull();
    expect(worstDegraded([null, s(null)])).toBeNull();
    expect(worstDegraded([s(null), s('errors')])).toBe('errors');
    expect(worstDegraded([s('errors'), s('needs_reauth')])).toBe('needs_reauth');
  });
});

describe('risk notify: degraded episodes', () => {
  it('tells a linked org admin once and stamps the episode', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');

    await runNotice();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await stamp()).toEqual({
      at: new Date(NOW).toISOString(),
      reason: 'needs_reauth',
    });
  });

  it('collapses a multi-board org to one message', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(
      env,
      config({
        boards: [
          { boardId: 1, name: 'A' },
          { boardId: 2, name: 'B' },
          { boardId: 3, name: 'C' },
        ],
      }),
    );
    for (const id of [1, 2, 3]) await markDegraded(env, CLOUD, id, 'needs_reauth');

    await runNotice();
    expect(fetchMock).toHaveBeenCalledTimes(1); // one DM, not three
  });

  it('is idempotent: re-running the same tick loses the claim', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');

    await runNotice();
    await runNotice();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-tells the admins only once the renotify cadence has passed', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');

    await runNotice();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await runNotice(NOW + 23 * 60 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still inside the 24h window

    await runNotice(NOW + 25 * 60 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await stamp()).at).toBe(new Date(NOW + 25 * 60 * 60_000).toISOString());
  });

  it('notifies immediately when the reason changes, cadence notwithstanding', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(env, config());
    await claimDegradedNotice(env, CLOUD, 'needs_reauth', null, new Date(NOW).toISOString());
    // The boards are now failing for a different, differently-fixed reason.
    await markDegraded(env, CLOUD, 5, 'errors');

    await runNotice(NOW + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await stamp()).reason).toBe('errors');
  });
});

describe('risk notify: recipients', () => {
  it('reaches org admins only — not plain members, not admins of another org', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await seedUser(MEMBER); // in the org, not an admin
    await seedUser(FOREIGN_ADMIN, { admin: true, cloudId: OTHER }); // admin, other org
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');

    expect(await orgAdmins(env, dao, CLOUD)).toEqual([ADMIN]);
    await runNotice();
    expect(fetchMock).toHaveBeenCalledTimes(1); // one recipient, one DM
  });

  it('skips an admin who has turned the channel off', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await dao.setChannelEnabled(ADMIN, 'zulip', false); // opted out, still linked
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');

    await runNotice();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers under the ORG's config (deliver receives orgId = cfg.cloudId)", async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    // The admin's link row points at ANOTHER org; the notice is about CLOUD, so
    // CLOUD's admin-provisioned bot must be the one that sends it.
    await seedZulipOrgConfig(env, OTHER, { site: 'https://two.zulipchat.com', webhookToken: 't2' });
    await saveLink(env, ADMIN, `zulip-${ADMIN}`, ADMIN, OTHER);
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');

    await runNotice();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://org.zulipchat.com/api/v1/messages',
    );
  });

  it('falls back to the bootstrap admin when the org has none', async () => {
    okFetch();
    await seedUser(MEMBER);
    expect(await orgAdmins(env, dao, CLOUD)).toEqual([BOOTSTRAP]);
  });

  it('claims the episode even when nobody is reachable, and never throws', async () => {
    const fetchMock = okFetch();
    // An org admin with no linked channel; the bootstrap admin isn't linked either.
    await seedUser(ADMIN, { admin: true, linked: false });
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');

    await runNotice();
    expect(fetchMock).not.toHaveBeenCalled();
    // Claimed anyway: an unreachable org must not re-attempt every 3-minute tick.
    expect((await stamp()).at).toBe(new Date(NOW).toISOString());
    await runNotice(NOW + 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('risk notify: recovery', () => {
  it('announces the recovery once and closes the episode', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(env, config());
    await markDegraded(env, CLOUD, 5, 'needs_reauth');
    await runNotice();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The board refreshed successfully: degraded_reason is cleared.
    await recordSuccess(env, CLOUD, 5);
    await runNotice(NOW + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await stamp()).toEqual({ at: null, reason: null });

    // Nothing more to say on later ticks.
    await runNotice(NOW + 120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says nothing about an org that was never degraded', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(env, config());
    await recordSuccess(env, CLOUD, 5);

    await runNotice();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await stamp()).toEqual({ at: null, reason: null });
  });
});

describe('risk notify: erased refresher (the hole this closes)', () => {
  it('notifies on the next tick even though no board is eligible', async () => {
    const fetchMock = okFetch();
    await seedUser(ADMIN, { admin: true });
    await putConfig(env, config());

    // GDPR erasure of the refresher: nulls refresher_account_id and degrades every
    // board OUTSIDE the cron, so nothing hung off refreshOrg would ever fire.
    await riskEraseAccount(env, REFRESHER);
    expect((await getState(env, CLOUD, 5))?.degradedReason).toBe('needs_reauth');

    await refreshRiskBoards(env, dao, silent, Date.now(), 0);

    // Exactly one fetch, and it is the admin DM — no Jira call was possible.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('zulipchat.com');
    expect((await stamp()).reason).toBe('needs_reauth');
  });
});
