// The risk board's own persistence: config JSON round-trips, snapshots are
// overwrite-only (one row per board however often the cron runs), and the refresh
// state machine (viewed / success / failure -> degraded at 5 / reset on success /
// board removal). Real SQL via schema.sql + SqliteD1, like dao.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { RiskBoardSnapshot } from '@shared/risk';
import type { Env } from '../src/env';
import {
  MAX_CONSECUTIVE_FAILURES,
  deleteBoardState,
  getConfig,
  getSnapshot,
  getState,
  listConfigs,
  markDegraded,
  markViewed,
  overwriteSnapshot,
  putConfig,
  recordFailure,
  recordSuccess,
  riskEraseAccount,
  setDevStatusAvailable,
  type RiskOrgConfigInput,
} from '../src/risk/store';
import { DEFAULT_COMPOSITE, DEFAULT_CUTOFFS, DEFAULT_SCHEDULE } from '../src/risk/logic/defaults';
import { SqliteD1 } from './support/sqlite-d1';

const CLOUD = 'cloud-1';
const OTHER = 'cloud-2';

let db: SqliteD1;
let env: Env;

beforeEach(() => {
  db = new SqliteD1();
  env = { DB: db } as unknown as Env;
});

function config(over: Partial<RiskOrgConfigInput> = {}): RiskOrgConfigInput {
  return {
    cloudId: CLOUD,
    boards: [{ boardId: 5, name: 'Sites' }],
    cutoffs: null,
    composite: null,
    schedule: null,
    fields: {},
    inProgressStatus: null,
    devStatusAvailable: null,
    refresherAccountId: 'acct-refresher',
    configuredBy: 'acct-admin',
    ...over,
  };
}

function snapshot(boardId: number, computedAt: string): RiskBoardSnapshot {
  return {
    boardId,
    boardName: 'Sites',
    columns: ['To Do', 'Done'],
    tickets: [],
    tierCounts: { risk: 0, warn: 0, ok: 0 },
    cutoffs: DEFAULT_CUTOFFS,
    composite: DEFAULT_COMPOSITE,
    schedule: DEFAULT_SCHEDULE,
    computedAt,
  };
}

describe('risk store: config', () => {
  it('round-trips the JSON columns and upserts in place', async () => {
    await putConfig(env, config());
    const bare = await getConfig(env, CLOUD);
    expect(bare?.boards).toEqual([{ boardId: 5, name: 'Sites' }]);
    expect(bare?.cutoffs).toBeNull(); // NULL means "use the code defaults"
    expect(bare?.devStatusAvailable).toBeNull(); // unprobed
    expect(bare?.updatedAt).toBeTruthy();

    await putConfig(
      env,
      config({
        boards: [
          { boardId: 5, name: 'Sites' },
          { boardId: 9, name: 'Comms' },
        ],
        cutoffs: DEFAULT_CUTOFFS,
        composite: { p: 3, weights: { idle: 2 } },
        schedule: DEFAULT_SCHEDULE,
        fields: { flagged: 'customfield_10002', rejections: null },
        inProgressStatus: 'Doing',
      }),
    );
    const cfg = await getConfig(env, CLOUD);
    expect(cfg?.boards).toHaveLength(2);
    expect(cfg?.cutoffs).toEqual(DEFAULT_CUTOFFS);
    expect(cfg?.composite).toEqual({ p: 3, weights: { idle: 2 } });
    expect(cfg?.schedule).toEqual(DEFAULT_SCHEDULE);
    expect(cfg?.fields).toEqual({ flagged: 'customfield_10002', rejections: null });
    expect(cfg?.inProgressStatus).toBe('Doing');
    expect(await listConfigs(env)).toHaveLength(1); // upsert, not insert
  });

  it('records the dev-status probe verdict once', async () => {
    await putConfig(env, config());
    await setDevStatusAvailable(env, CLOUD, false);
    expect((await getConfig(env, CLOUD))?.devStatusAvailable).toBe(false);
  });

  it('lists every configured org for the fleet scheduler', async () => {
    await putConfig(env, config());
    await putConfig(env, config({ cloudId: OTHER }));
    expect((await listConfigs(env)).map((c) => c.cloudId)).toEqual([CLOUD, OTHER]);
    expect(await getConfig(env, 'cloud-unknown')).toBeNull();
  });
});

describe('risk store: snapshots', () => {
  it('overwrites rather than accumulating', async () => {
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:05:00.000Z'));
    const rows = await env.DB.prepare(`SELECT * FROM risk_snapshots`).all();
    expect(rows.results).toHaveLength(1);
    expect((await getSnapshot(env, CLOUD, 5))?.computedAt).toBe('2026-07-01T10:05:00.000Z');
  });

  it('scopes snapshots by org and board', async () => {
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
    expect(await getSnapshot(env, OTHER, 5)).toBeNull();
    expect(await getSnapshot(env, CLOUD, 6)).toBeNull();
  });
});

describe('risk store: refresh state', () => {
  it('tracks views and successful refreshes independently', async () => {
    await markViewed(env, CLOUD, 5, '2026-07-01T09:00:00.000Z');
    expect((await getState(env, CLOUD, 5))?.lastRefreshAt).toBeNull();
    await recordSuccess(env, CLOUD, 5, '2026-07-01T09:03:00.000Z');
    const s = await getState(env, CLOUD, 5);
    expect(s).toMatchObject({
      lastViewedAt: '2026-07-01T09:00:00.000Z', // preserved by the refresh upsert
      lastRefreshAt: '2026-07-01T09:03:00.000Z',
      failures: 0,
      degradedReason: null,
    });
  });

  it('degrades after consecutive failures and recovers on success', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
      await recordFailure(env, CLOUD, 5, '2026-07-01T09:00:00.000Z');
    }
    expect(await getState(env, CLOUD, 5)).toMatchObject({
      failures: MAX_CONSECUTIVE_FAILURES - 1,
      degradedReason: null,
    });
    await recordFailure(env, CLOUD, 5, '2026-07-01T09:03:00.000Z');
    expect(await getState(env, CLOUD, 5)).toMatchObject({
      failures: MAX_CONSECUTIVE_FAILURES,
      degradedReason: 'errors',
    });
    await recordSuccess(env, CLOUD, 5, '2026-07-01T09:06:00.000Z');
    expect(await getState(env, CLOUD, 5)).toMatchObject({ failures: 0, degradedReason: null });
  });

  it('marks a re-auth degradation without counting it as a failure', async () => {
    await markDegraded(env, CLOUD, 5, 'needs_reauth', '2026-07-01T09:00:00.000Z');
    expect(await getState(env, CLOUD, 5)).toMatchObject({
      failures: 0,
      degradedReason: 'needs_reauth',
    });
  });

  it('erases an account: nulls both id columns, drops the org’s snapshots, degrades it', async () => {
    await putConfig(env, config()); // refresher acct-refresher, configuredBy acct-admin
    await putConfig(env, config({ cloudId: OTHER, refresherAccountId: 'acct-someone-else' }));
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
    await overwriteSnapshot(env, OTHER, snapshot(5, '2026-07-01T10:00:00.000Z'));

    await riskEraseAccount(env, 'acct-refresher');

    const erased = await getConfig(env, CLOUD);
    expect(erased?.refresherAccountId).toBeNull();
    expect(await getSnapshot(env, CLOUD, 5)).toBeNull();
    // The org can no longer refresh, so say so instead of serving stale names.
    expect((await getState(env, CLOUD, 5))?.degradedReason).toBe('needs_reauth');

    // An unrelated org keeps its refresher and its snapshot.
    const untouched = await getConfig(env, OTHER);
    expect(untouched?.refresherAccountId).toBe('acct-someone-else');
    expect(await getSnapshot(env, OTHER, 5)).not.toBeNull();
  });

  it('erases the audit id even when the account is not anyone’s refresher', async () => {
    await putConfig(env, config({ configuredBy: 'acct-admin' }));
    await riskEraseAccount(env, 'acct-admin');
    const cfg = await getConfig(env, CLOUD);
    expect(cfg?.configuredBy).toBeNull();
    expect(cfg?.refresherAccountId).toBe('acct-refresher'); // untouched
  });

  it('drops snapshot + state when a board leaves the config', async () => {
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
    await recordSuccess(env, CLOUD, 5, '2026-07-01T10:00:00.000Z');
    await deleteBoardState(env, CLOUD, 5);
    expect(await getState(env, CLOUD, 5)).toBeNull();
    expect(await getSnapshot(env, CLOUD, 5)).toBeNull();
  });
});
