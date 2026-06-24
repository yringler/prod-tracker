// GDPR personal-data reporting + erasure, tested against real SQL (SqliteD1) with
// a stubbed fetch for the report-accounts API. Mirrors dao.test.ts setup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { reportPersonalData } from '../src/cron/pd-report';
import { SqliteD1 } from './support/sqlite-d1';

const CLOUD = 'cloud-1';
const ALICE = 'acct-alice';
const BOB = 'acct-bob';
const OWNER = 'acct-owner';

let db: SqliteD1;
let dao: Dao;

beforeEach(() => {
  db = new SqliteD1();
  dao = new Dao(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv(bootstrapAdmin = ''): Env {
  return {
    DB: db,
    BOOTSTRAP_ADMIN_ACCOUNT_ID: bootstrapAdmin,
    JIRA_CLIENT_ID: 'cid',
    JIRA_CLIENT_SECRET: 'secret',
  } as unknown as Env;
}

async function seedFreshToken(accountId: string): Promise<void> {
  await dao.upsertToken({
    accountId,
    refreshToken: 'refresh',
    accessToken: `access-${accountId}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

interface FakeResp {
  status?: number;
  body?: unknown;
  retryAfter?: string;
}
function resp({ status = 200, body, retryAfter }: FakeResp): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
    json: async () => body,
  } as unknown as Response;
}

describe('accountsForReport', () => {
  it('unions every account-bearing table and excludes already-erased ids', async () => {
    await dao.upsertUser(ALICE, 'Alice', CLOUD); // sets last_seen_at
    await seedFreshToken(OWNER); // only in oauth_tokens
    await dao.insertRating({
      cloudId: CLOUD,
      issueKey: 'ABC-2',
      raterAccountId: BOB, // only as a rater, no user row
      claimedPoints: 4,
      storyPointsAtRating: 8,
      teamIdAtRating: null,
      sprintId: 10,
    });
    await dao.saveSubscription('acct-dave', 'https://push/1', 'p', 'a');
    // An already-anonymized rating must NOT be reported.
    await dao.insertRating({
      cloudId: CLOUD,
      issueKey: 'ABC-3',
      raterAccountId: 'erased:dead-beef',
      claimedPoints: 3,
      storyPointsAtRating: 3,
      teamIdAtRating: null,
      sprintId: 10,
    });

    const rows = await dao.accountsForReport();
    const ids = rows.map((r) => r.accountId).sort();
    expect(ids).toEqual([ALICE, 'acct-dave', BOB, OWNER].sort());
    expect(ids).not.toContain('erased:dead-beef');

    // Alice's updatedAt is her stored last_seen_at; the token-only account falls
    // back to a fresh timestamp (still a valid ISO string).
    const aliceLastSeen = await db
      .prepare(`SELECT last_seen_at FROM users WHERE account_id = ?`)
      .bind(ALICE)
      .first<{ last_seen_at: string }>();
    expect(rows.find((r) => r.accountId === ALICE)!.updatedAt).toBe(aliceLastSeen!.last_seen_at);
    expect(Number.isNaN(Date.parse(rows.find((r) => r.accountId === OWNER)!.updatedAt))).toBe(false);
  });
});

describe('accountsDueForReport', () => {
  it('excludes accounts reported within the cycle, includes stale ones', async () => {
    await dao.upsertUser(ALICE, 'Alice', CLOUD);
    await dao.upsertUser(BOB, 'Bob', CLOUD);
    const t0 = Date.parse('2026-06-01T00:00:00.000Z');
    await dao.markReported([ALICE], new Date(t0).toISOString());

    const cycle = 7 * 24 * 60 * 60 * 1000;
    const dueSoon = await dao.accountsDueForReport(cycle, t0 + 60_000);
    expect(dueSoon.map((r) => r.accountId).sort()).toEqual([BOB]);

    const dueLater = await dao.accountsDueForReport(cycle, t0 + 8 * 24 * 60 * 60 * 1000);
    expect(dueLater.map((r) => r.accountId).sort()).toEqual([ALICE, BOB].sort());
  });
});

describe('eraseAccount', () => {
  it('hard-deletes PD, pseudonymizes analytics, nulls appointed_by references', async () => {
    const teamId = await dao.createTeam(CLOUD, 'Site');
    await dao.upsertUser(ALICE, 'Alice', CLOUD);
    await dao.upsertUser(BOB, 'Bob', CLOUD);
    await seedFreshToken(ALICE);
    await dao.upsertSite(ALICE, { cloudId: CLOUD, name: 'Site', siteUrl: 'https://x.atlassian.net' });
    await dao.appointAdmin(ALICE, null);
    await dao.appointAdmin(BOB, ALICE); // BOB appointed BY Alice
    await dao.assignMembership(ALICE, teamId, '2026-05-01T00:00:00.000Z');
    await dao.assignMembership(BOB, teamId, '2026-05-01T00:00:00.000Z');
    await dao.upsertSprint({
      cloudId: CLOUD,
      sprintId: 10,
      boardId: 1,
      name: 'Sprint 10',
      startAt: '2026-05-01T00:00:00.000Z',
      endAt: '2026-05-15T00:00:00.000Z',
    });
    await dao.insertRating({
      cloudId: CLOUD,
      issueKey: 'ABC-1',
      raterAccountId: ALICE,
      claimedPoints: 5,
      storyPointsAtRating: 5,
      teamIdAtRating: teamId,
      sprintId: 10,
    });
    await dao.insertRating({
      cloudId: CLOUD,
      issueKey: 'ABC-2',
      raterAccountId: BOB,
      claimedPoints: 4,
      storyPointsAtRating: 8,
      teamIdAtRating: teamId,
      sprintId: 10,
    });
    await dao.insertDoneEvent({
      cloudId: CLOUD,
      issueKey: 'ABC-1',
      storyPoints: 5,
      sprintId: 10,
      transitionedToDoneAt: '2026-05-10T00:00:00.000Z',
      changelogId: '9001',
      accountId: ALICE,
      teamIdAtDone: teamId,
    });
    await dao.insertPending({
      pendingId: `${CLOUD}:ABC-9:1`,
      cloudId: CLOUD,
      accountId: ALICE,
      issueKey: 'ABC-9',
      title: 'T',
      url: 'u',
      storyPoints: 3,
      toStatus: 'In Progress',
      changelogId: '1',
      transitionedAt: '2026-05-10T00:00:00.000Z',
    });
    await dao.saveSubscription(ALICE, 'https://push/1', 'p', 'a');
    const sid = await dao.createSession(ALICE, CLOUD, 3600);
    await dao.markReported([ALICE], new Date().toISOString());

    const before = await dao.teamSeries(CLOUD, teamId, '1970-01-01T00:00:00.000Z');
    const s10Before = before.find((s) => s.sprintId === 10)!;

    await dao.eraseAccount(ALICE);

    // Hard-deleted everywhere identifying.
    expect(await dao.getToken(ALICE)).toBeNull();
    expect(await dao.listSites(ALICE)).toHaveLength(0);
    expect(await dao.isAdmin(ALICE)).toBe(false);
    expect(await dao.teamAt(ALICE, '2026-06-01T00:00:00.000Z')).toBeNull();
    expect(await dao.getPendingForOwner(ALICE)).toHaveLength(0);
    expect(await dao.subscriptionsFor(ALICE)).toHaveLength(0);
    expect(await dao.getSession(sid)).toBeNull();
    expect(await dao.getRatingsForOwner(ALICE)).toHaveLength(0); // rewritten away
    // user row gone -> display name falls back to the (non-name) accountId.
    expect(await dao.getDisplayName(ALICE)).toBe(ALICE);

    // appointed_by reference to Alice is nulled, but Bob stays an admin.
    expect(await dao.isAdmin(BOB)).toBe(true);
    const bobAdmin = await db
      .prepare(`SELECT appointed_by FROM admins WHERE account_id = ?`)
      .bind(BOB)
      .first<{ appointed_by: string | null }>();
    expect(bobAdmin!.appointed_by).toBeNull();

    // Aggregates are unchanged: ratings/done rows survived (pseudonymized), so sums
    // and the distinct-rater count are identical.
    const after = await dao.teamSeries(CLOUD, teamId, '1970-01-01T00:00:00.000Z');
    const s10After = after.find((s) => s.sprintId === 10)!;
    expect(s10After.claimedPoints).toBe(s10Before.claimedPoints);
    expect(s10After.donePoints).toBe(s10Before.donePoints);
    expect(s10After.claimedPerActiveRater).toBe(s10Before.claimedPerActiveRater);

    // No erased state row left behind, and Alice no longer appears for reporting.
    const ids = (await dao.accountsForReport()).map((r) => r.accountId);
    expect(ids).not.toContain(ALICE);
  });
});

describe('reportPersonalData', () => {
  it('marks every account reported on 204', async () => {
    await dao.upsertUser(ALICE, 'Alice', CLOUD);
    await dao.upsertUser(BOB, 'Bob', CLOUD);
    await seedFreshToken(OWNER);
    vi.stubGlobal('fetch', vi.fn(async () => resp({ status: 204 })));

    await reportPersonalData(makeEnv(), dao);

    expect(await dao.accountsDueForReport(7 * 24 * 60 * 60 * 1000, Date.now())).toHaveLength(0);
  });

  it('erases a closed account and does not re-store its state', async () => {
    await dao.upsertUser(BOB, 'Bob', CLOUD);
    await seedFreshToken(OWNER);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resp({ status: 200, body: { accounts: [{ accountId: BOB, status: 'closed' }] } })),
    );

    await reportPersonalData(makeEnv(), dao);

    // Bob is gone from all PD, including pd_report_state.
    const ids = (await dao.accountsForReport()).map((r) => r.accountId);
    expect(ids).not.toContain(BOB);
    const state = await db
      .prepare(`SELECT account_id FROM pd_report_state WHERE account_id = ?`)
      .bind(BOB)
      .first();
    expect(state).toBeNull();
  });

  it('refreshes the stored display name on "updated"', async () => {
    await dao.upsertUser(ALICE, 'Stale Name', CLOUD);
    await seedFreshToken(ALICE);
    await dao.upsertSite(ALICE, { cloudId: CLOUD, name: 'Site', siteUrl: 'https://x.atlassian.net' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/rest/api/3/myself')) {
          return resp({ status: 200, body: { accountId: ALICE, displayName: 'Fresh Name' } });
        }
        return resp({ status: 200, body: { accounts: [{ accountId: ALICE, status: 'updated' }] } });
      }),
    );

    await reportPersonalData(makeEnv(), dao);

    expect(await dao.getDisplayName(ALICE)).toBe('Fresh Name');
  });

  it('halts on 429 without marking anything reported', async () => {
    await dao.upsertUser(ALICE, 'Alice', CLOUD);
    await seedFreshToken(OWNER);
    vi.stubGlobal('fetch', vi.fn(async () => resp({ status: 429, retryAfter: '30' })));

    await reportPersonalData(makeEnv(), dao);

    // Nothing marked -> still due next tick.
    const due = await dao.accountsDueForReport(7 * 24 * 60 * 60 * 1000, Date.now());
    expect(due.map((r) => r.accountId)).toContain(ALICE);
  });
});
