// D1 usage meter + the write-volume fixes that motivated it:
//   - the meter attributes rows read/written to a source and flushes additively,
//   - the poller's sprint refresh writes only new/changed sprints,
//   - the risk board's 20 s view poll stamps last_viewed_at at most every 5 min,
//   - authenticated requests stamp users.last_active_at at most hourly,
//   - /api/global/* is operator-only (GLOBAL_ADMIN_ACCOUNT_IDS) and 404s otherwise.
import { beforeEach, describe, expect, it } from 'vitest';
import type { GlobalOverviewResponse } from '@shared/contracts';
import worker from '../src/index';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import { authenticate, isGlobalAdmin } from '../src/http';
import { getState, markViewed } from '../src/risk/store';
import { UsageMeter, meterD1, routeLabel } from '../src/usage/meter';
import {
  FLUSH_INTERVAL_MS,
  accumulate,
  maybeFlush,
  resetUsageBuffer,
  usageSince,
} from '../src/usage/store';
import { SqliteD1 } from './support/sqlite-d1';

const CLOUD = 'cloud-1';
const OP = 'acct-operator';
const DEV = 'acct-dev';

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(async () => {
  resetUsageBuffer();
  db = new SqliteD1();
  dao = new Dao(db);
  env = { DB: db, GLOBAL_ADMIN_ACCOUNT_IDS: ` ${OP} , other ` } as unknown as Env;
  await dao.upsertUser(OP, 'Op', CLOUD);
  await dao.upsertUser(DEV, 'Dev', CLOUD);
  await dao.upsertSite(OP, { cloudId: CLOUD, name: 'Site', siteUrl: 'https://s' });
  await dao.upsertSite(DEV, { cloudId: CLOUD, name: 'Site', siteUrl: 'https://s' });
});

describe('routeLabel', () => {
  it('collapses ids into :id so sources stay low-cardinality', () => {
    expect(routeLabel('GET', '/api/risk/board/12')).toBe('GET /api/risk/board/:id');
    expect(routeLabel('DELETE', '/api/admin/admins/557058:abcd-ef')).toBe(
      'DELETE /api/admin/admins/:id',
    );
    expect(routeLabel('PUT', '/api/notifications/email/enabled')).toBe(
      'PUT /api/notifications/email/enabled',
    );
  });
});

describe('meterD1', () => {
  it('tallies queries and writes per source, including batches and first()', async () => {
    const meter = new UsageMeter('test:a');
    const mdb = meterD1(db, meter);
    const mdao = new Dao(mdb);
    await mdao.upsertUser('x', 'X', CLOUD); // run(): 1 write
    expect(await mdao.getDisplayName('x')).toBe('X'); // first()
    meter.setSource('test:b');
    await mdao.markReported(['x', 'y'], '2026-01-01T00:00:00.000Z'); // batch: 2 writes
    const by = Object.fromEntries(meter.entries());
    expect(by['test:a']).toMatchObject({ invocations: 1, queries: 2, rowsWritten: 1 });
    expect(by['test:b']).toMatchObject({ invocations: 1, queries: 2, rowsWritten: 2 });
  });
});

describe('usage store', () => {
  it('flushes additively per (hour, source) and throttles non-forced flushes', async () => {
    const t0 = Date.parse('2026-11-17T10:15:00.000Z');
    const m1 = new UsageMeter('GET /api/pending');
    m1.record({ rows_read: 3, rows_written: 1 }, 0);
    accumulate(m1, t0);
    await maybeFlush(db, { nowMs: t0 });

    const m2 = new UsageMeter('GET /api/pending');
    m2.record({ rows_read: 4, rows_written: 0 }, 0);
    accumulate(m2, t0 + 1000);
    await maybeFlush(db, { nowMs: t0 + 1000 }); // throttled: still buffered
    let rows = await usageSince(db, '2026-11-17T00:00:00.000Z');
    expect(rows[0]).toMatchObject({ invocations: 1, rowsRead: 3, rowsWritten: 1 });

    await maybeFlush(db, { nowMs: t0 + FLUSH_INTERVAL_MS + 1000 });
    rows = await usageSince(db, '2026-11-17T00:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bucket: '2026-11-17T10:00:00.000Z',
      source: 'GET /api/pending',
      invocations: 2,
      queries: 2,
      rowsRead: 7,
      rowsWritten: 1,
    });
  });

  it('prunes buckets past retention on a pruning flush', async () => {
    const old = new UsageMeter('cron:poll');
    accumulate(old, Date.parse('2026-01-01T00:00:00.000Z'));
    await maybeFlush(db, { force: true, nowMs: Date.parse('2026-01-01T00:00:00.000Z') });
    await maybeFlush(db, { force: true, prune: true, nowMs: Date.parse('2026-11-17T00:00:00.000Z') });
    expect(await usageSince(db, '2000-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('sprint refresh writes only what changed', () => {
  const sp = (id: number, name = `S${id}`, boardId = 1) => ({
    sprintId: id,
    boardId,
    name,
    startAt: '2026-01-01T00:00:00.000Z',
    endAt: '2026-01-15T00:00:00.000Z',
  });

  it('writes new rows, then nothing for an identical re-list, then only the changed one', async () => {
    const list = [sp(1), sp(2), sp(3)];
    expect(await dao.upsertChangedSprints(CLOUD, list)).toBe(3);
    expect(await dao.upsertChangedSprints(CLOUD, list)).toBe(0);
    expect(await dao.upsertChangedSprints(CLOUD, [sp(1), sp(2, 'Renamed'), sp(3)])).toBe(1);
    const windows = await dao.sprintWindows(CLOUD);
    expect(windows).toHaveLength(3);
  });

  it('a sprint shared by two boards settles instead of rewriting every tick', async () => {
    const list = [sp(7, 'Shared', 1), sp(7, 'Shared', 2)];
    expect(await dao.upsertChangedSprints(CLOUD, list)).toBe(1);
    expect(await dao.upsertChangedSprints(CLOUD, list)).toBe(0);
  });
});

describe('risk markViewed throttle', () => {
  it('re-stamps last_viewed_at only once it is 5+ minutes stale', async () => {
    await markViewed(env, CLOUD, 5, '2026-07-01T09:00:00.000Z');
    await markViewed(env, CLOUD, 5, '2026-07-01T09:04:00.000Z');
    expect((await getState(env, CLOUD, 5))?.lastViewedAt).toBe('2026-07-01T09:00:00.000Z');
    await markViewed(env, CLOUD, 5, '2026-07-01T09:05:00.000Z');
    expect((await getState(env, CLOUD, 5))?.lastViewedAt).toBe('2026-07-01T09:05:00.000Z');
  });
});

describe('last_active_at', () => {
  it('is stamped on the first authenticated request and not again within the hour', async () => {
    const sid = await dao.createSession(DEV, CLOUD, 3600);
    const req = () => new Request('https://app.example/api/x', { headers: { Cookie: `sid=${sid}` } });
    expect((await dao.getSession(sid))?.lastActiveAt).toBeNull();
    await authenticate(req(), env, dao);
    const first = (await dao.getSession(sid))?.lastActiveAt;
    expect(first).toBeTruthy();
    await authenticate(req(), env, dao);
    expect((await dao.getSession(sid))?.lastActiveAt).toBe(first);
  });
});

describe('operator gate', () => {
  async function fetchAs(accountId: string, path: string): Promise<Response> {
    const sid = await dao.createSession(accountId, CLOUD, 3600);
    return worker.fetch(
      new Request(`https://app.example${path}`, { headers: { Cookie: `sid=${sid}` } }),
      env,
    );
  }

  it('parses the comma-separated secret and is independent of org admin', async () => {
    expect(isGlobalAdmin(env, OP)).toBe(true);
    expect(isGlobalAdmin(env, 'other')).toBe(true);
    expect(isGlobalAdmin(env, DEV)).toBe(false);
    await dao.appointAdmin(DEV, null);
    expect(isGlobalAdmin(env, DEV)).toBe(false);
    expect(isGlobalAdmin({ ...env, GLOBAL_ADMIN_ACCOUNT_IDS: '' }, OP)).toBe(false);
  });

  it('404s for non-operators (even org admins) and serves operators', async () => {
    await dao.appointAdmin(DEV, null);
    expect((await fetchAs(DEV, '/api/global/overview')).status).toBe(404);
    const res = await fetchAs(OP, '/api/global/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GlobalOverviewResponse;
    expect(body.totals.users).toBe(2);
    expect(body.orgs.map((o) => o.cloudId)).toEqual([CLOUD]);
    expect(body.tables.some((t) => t.name === 'usage_stats')).toBe(true);
    // The overview request itself was metered (fetch flushes when it can't waitUntil).
    const rows = await usageSince(db, '2000-01-01T00:00:00.000Z');
    expect(rows.some((r) => r.source === 'GET /api/global/overview')).toBe(true);
  });
});
