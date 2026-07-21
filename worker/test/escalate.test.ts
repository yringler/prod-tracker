// Escalation end-to-end: a pending_ratings row older than ESCALATION_DELAY_MS with a
// linked Zulip user gets one DM and is marked escalated exactly once; a user with no
// channel is still marked (time-bound window); a stale (> PENDING_MAX_AGE_MS) row is
// never escalated. Real SQL (SqliteD1) + stubbed fetch, mirroring pd-report.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESCALATION_DELAY_MS, PENDING_MAX_AGE_MS } from '@shared/domain';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { escalate } from '../src/cron/escalate';
import { saveLink } from '../src/notifications/adapters/zulip/store';
import { log } from '../src/log';
import { SqliteD1 } from './support/sqlite-d1';
import { seedZulipOrgConfig, TEST_SECRETS_KEY } from './support/zulip-org';

const CLOUD = 'cloud-1';
const ALICE = 'acct-alice';

let db: SqliteD1;
let dao: Dao;
let env: Env;

const silent = log.child({ quiet: true }); // structured logger; output is ignored in tests

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = {
    DB: db,
    APP_ORIGIN: 'https://app.example',
    SECRETS_KEY: TEST_SECRETS_KEY,
  } as unknown as Env;
  // Zulip config is per-org DB rows since 0008; deliver resolves the org from the link.
  await seedZulipOrgConfig(env, CLOUD);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Insert a pending row with an explicit created_at (insertPending stamps now()). */
async function seedPending(
  accountId: string,
  pendingId: string,
  createdAtMs: number,
  issueKey = 'ABC-1',
  changelogId = '900',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_ratings
         (pending_id, cloud_id, account_id, issue_key, title, url, story_points, to_status, changelog_id, transitioned_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      pendingId, CLOUD, accountId, issueKey, 'Do the thing', `https://jira/${issueKey}`,
      3, 'Done', changelogId, new Date(createdAtMs).toISOString(), new Date(createdAtMs).toISOString(),
    )
    .run();
}

async function escalatedAt(pendingId: string): Promise<string | null> {
  const r = await db
    .prepare(`SELECT escalated_at FROM pending_ratings WHERE pending_id = ?`)
    .bind(pendingId)
    .first<{ escalated_at: string | null }>();
  return r?.escalated_at ?? null;
}

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response);
}

describe('escalate', () => {
  it('delivers one DM to a linked user and marks the row escalated once', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const ripe = Date.now() - ESCALATION_DELAY_MS - 60_000;
    await seedPending(ALICE, 'p-ripe', ripe);
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    await escalate(env, dao, silent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await escalatedAt('p-ripe')).not.toBeNull();

    // Idempotent: a second run does nothing (escalated_at IS NULL filter excludes it).
    await escalate(env, dao, silent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not deliver to a DISABLED channel, and falls through to the next enabled one', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const ripe = Date.now() - ESCALATION_DELAY_MS - 60_000;
    await seedPending(ALICE, 'p-ripe', ripe);
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');
    await dao.setChannelEnabled(ALICE, 'zulip', false);

    await escalate(env, dao, silent);
    // Opted out: no send at all, even though the identity is still linked.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await escalatedAt('p-ripe')).not.toBeNull();
  });

  it('re-enabling restores delivery without re-linking', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const ripe = Date.now() - ESCALATION_DELAY_MS - 60_000;
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');
    await dao.setChannelEnabled(ALICE, 'zulip', false);
    await dao.setChannelEnabled(ALICE, 'zulip', true);
    await seedPending(ALICE, 'p-ripe', ripe);

    await escalate(env, dao, silent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('collapses a flurry to one DM but marks every row escalated', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const ripe = Date.now() - ESCALATION_DELAY_MS - 60_000;
    // Three ripe rows for the SAME account+issue (a flurry of status moves).
    await seedPending(ALICE, 'p-a', ripe, 'ABC-1', '900');
    await seedPending(ALICE, 'p-b', ripe + 1_000, 'ABC-1', '901');
    await seedPending(ALICE, 'p-c', ripe + 2_000, 'ABC-1', '902');
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    await escalate(env, dao, silent);
    // One DM, not three.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Every collapsed sibling is marked, so none re-escalates next tick.
    expect(await escalatedAt('p-a')).not.toBeNull();
    expect(await escalatedAt('p-b')).not.toBeNull();
    expect(await escalatedAt('p-c')).not.toBeNull();

    // Idempotent: a second run does nothing (all excluded by escalated_at IS NULL).
    await escalate(env, dao, silent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('two different issues for one user produce two DMs', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const ripe = Date.now() - ESCALATION_DELAY_MS - 60_000;
    await seedPending(ALICE, 'p-1', ripe, 'ABC-1', '900');
    await seedPending(ALICE, 'p-2', ripe + 1_000, 'ABC-2', '901');
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    await escalate(env, dao, silent);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await escalatedAt('p-1')).not.toBeNull();
    expect(await escalatedAt('p-2')).not.toBeNull();
  });

  it('marks a ripe pending with no channels escalated without any fetch', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const ripe = Date.now() - ESCALATION_DELAY_MS - 60_000;
    await seedPending(ALICE, 'p-nochan', ripe);

    await escalate(env, dao, silent);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await escalatedAt('p-nochan')).not.toBeNull();
  });

  it('never escalates a stale row older than PENDING_MAX_AGE_MS', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const stale = Date.now() - PENDING_MAX_AGE_MS - 60_000;
    await seedPending(ALICE, 'p-stale', stale);
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    await escalate(env, dao, silent);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await escalatedAt('p-stale')).toBeNull();
  });

  it('does not escalate a fresh row within the delay window', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await seedPending(ALICE, 'p-fresh', Date.now());
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    await escalate(env, dao, silent);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await escalatedAt('p-fresh')).toBeNull();
  });

  // --- reminder cooldown + transition gating (issue_reminders) ---------------

  it('cooldown suppresses a genuinely-newer transition on the same issue', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const base = Date.now();
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    // First reminder goes out.
    await seedPending(ALICE, 'p-a', base - ESCALATION_DELAY_MS - 60_000, 'ABC-1', '900');
    await escalate(env, dao, silent, base);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A new transition (greater id) arrives and is ripe, but only 5 min later.
    await seedPending(ALICE, 'p-b', base - ESCALATION_DELAY_MS, 'ABC-1', '901');
    await escalate(env, dao, silent, base + 5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still cooling down → no re-send
    expect(await escalatedAt('p-b')).not.toBeNull(); // but window-closed regardless
  });

  it('re-sends once the cooldown passes and a newer transition exists', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const base = Date.now();
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    await seedPending(ALICE, 'p-a', base - ESCALATION_DELAY_MS - 60_000, 'ABC-1', '900');
    await escalate(env, dao, silent, base);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await seedPending(ALICE, 'p-b', base - ESCALATION_DELAY_MS, 'ABC-1', '901');
    await escalate(env, dao, silent, base + 11 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // transitioned AND cooldown passed
  });

  it('does not re-send after cooldown when there is no newer transition', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const base = Date.now();
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    await seedPending(ALICE, 'p-a', base - ESCALATION_DELAY_MS - 60_000, 'ABC-1', '900');
    await escalate(env, dao, silent, base);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same changelog id → not a new transition, even though cooldown has passed.
    await seedPending(ALICE, 'p-b', base - ESCALATION_DELAY_MS, 'ABC-1', '900');
    await escalate(env, dao, silent, base + 11 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await escalatedAt('p-b')).not.toBeNull();
  });

  it('a throwing getUserChannels leaves no claim, skips markEscalated, and retries cleanly', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const ripe = Date.now() - ESCALATION_DELAY_MS - 60_000;
    await seedPending(ALICE, 'p-ripe', ripe);
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    // First tick: the channel read throws before the claim is written.
    const spy = vi
      .spyOn(dao, 'getUserChannels')
      .mockRejectedValueOnce(new Error('transient channel-read failure'));
    await expect(escalate(env, dao, silent)).rejects.toThrow('transient channel-read failure');

    // No leaked claim row, and the window is NOT closed (markEscalated never ran).
    const rows = await db.prepare(`SELECT * FROM issue_reminders`).all();
    expect(rows.results).toHaveLength(0);
    expect(await escalatedAt('p-ripe')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    // Second tick (spy restored to real impl): clean retry delivers exactly once.
    spy.mockRestore();
    await escalate(env, dao, silent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await escalatedAt('p-ripe')).not.toBeNull();
  });

  it('two overlapping escalate() ticks reminder the same issue exactly once', async () => {
    // Deferred fetch: both ticks reach the claim-before-send CAS before either
    // delivers; only the winner fetches. Mirrors two crons racing on one issue.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, text: async () => '' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const base = Date.now();
    await seedPending(ALICE, 'p-ripe', base - ESCALATION_DELAY_MS - 60_000, 'ABC-1', '900');
    await saveLink(env, ALICE, '4242', 'Alice A', CLOUD);
    await dao.registerChannel(ALICE, 'zulip', 'Alice A');

    const run1 = escalate(env, dao, silent, base);
    const run2 = escalate(env, dao, silent, base);
    release();
    await Promise.all([run1, run2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await db.prepare(`SELECT * FROM issue_reminders`).all();
    expect(rows.results).toHaveLength(1);
  });
});
