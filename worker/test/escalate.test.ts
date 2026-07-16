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
});
