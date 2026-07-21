// The risk board's own persistence: config JSON round-trips, snapshots are
// overwrite-only (one row per board however often the cron runs), and the refresh
// state machine (viewed / success / failure -> degraded at 5 / reset on success /
// board removal). Real SQL via schema.sql + SqliteD1, like dao.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { RiskBoardSnapshot } from '@shared/risk';
import type { Env } from '../src/env';
import {
  MAX_CONSECUTIVE_FAILURES,
  claimDegradedNotice,
  clearDegradedNotice,
  deleteBoardState,
  getConfig,
  getSnapshot,
  getState,
  listConfigs,
  listSnapshotColumns,
  listSnapshots,
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
const AT = '2026-07-01T09:00:00.000Z';

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

  it('preserves an open degraded episode across an admin re-save', async () => {
    await putConfig(env, config());
    expect(await claimDegradedNotice(env, CLOUD, 'needs_reauth', null, AT)).toBe(true);

    await putConfig(env, config({ inProgressStatus: 'Doing' }));

    const cfg = await getConfig(env, CLOUD);
    expect(cfg?.inProgressStatus).toBe('Doing'); // the save landed...
    expect(cfg?.degradedNotifiedAt).toBe(AT); // ...without wiping the episode
    expect(cfg?.degradedNotifiedReason).toBe('needs_reauth');
  });
});

describe('risk store: degraded-notice CAS', () => {
  const LATER = '2026-07-02T09:00:00.000Z';

  it('claims once and rejects a caller holding a stale stamp', async () => {
    await putConfig(env, config());
    // Two ticks race off the same read (prev = null): exactly one wins.
    expect(await claimDegradedNotice(env, CLOUD, 'needs_reauth', null, AT)).toBe(true);
    expect(await claimDegradedNotice(env, CLOUD, 'needs_reauth', null, LATER)).toBe(false);
    expect((await getConfig(env, CLOUD))?.degradedNotifiedAt).toBe(AT);

    // A caller that read the current stamp may re-claim (the renotify cadence).
    expect(await claimDegradedNotice(env, CLOUD, 'errors', AT, LATER)).toBe(true);
    const cfg = await getConfig(env, CLOUD);
    expect(cfg?.degradedNotifiedAt).toBe(LATER);
    expect(cfg?.degradedNotifiedReason).toBe('errors');
  });

  it('clears once and rejects a stale clear', async () => {
    await putConfig(env, config());
    await claimDegradedNotice(env, CLOUD, 'needs_reauth', null, AT);

    expect(await clearDegradedNotice(env, CLOUD, LATER)).toBe(false); // never stamped LATER
    expect(await clearDegradedNotice(env, CLOUD, AT)).toBe(true);
    expect(await clearDegradedNotice(env, CLOUD, AT)).toBe(false); // already closed

    const cfg = await getConfig(env, CLOUD);
    expect(cfg?.degradedNotifiedAt).toBeNull();
    expect(cfg?.degradedNotifiedReason).toBeNull();
  });

  it('is org-scoped', async () => {
    await putConfig(env, config());
    await putConfig(env, config({ cloudId: OTHER }));
    await claimDegradedNotice(env, CLOUD, 'errors', null, AT);
    expect((await getConfig(env, OTHER))?.degradedNotifiedAt).toBeNull();
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

  // Feeds GET /api/admin/risk/columns — the cutoffs editor's column vocabulary,
  // read from the snapshot so the admin page costs zero Jira calls.
  describe('listSnapshotColumns', () => {
    it('returns one row per board, scoped to the org', async () => {
      await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
      await overwriteSnapshot(env, CLOUD, snapshot(9, '2026-07-01T10:01:00.000Z'));
      await overwriteSnapshot(env, OTHER, snapshot(77, '2026-07-01T10:02:00.000Z'));

      expect(await listSnapshotColumns(env, CLOUD)).toEqual([
        { boardId: 5, columns: ['To Do', 'Done'], computedAt: '2026-07-01T10:00:00.000Z' },
        { boardId: 9, columns: ['To Do', 'Done'], computedAt: '2026-07-01T10:01:00.000Z' },
      ]);
      expect((await listSnapshotColumns(env, OTHER)).map((r) => r.boardId)).toEqual([77]);
      expect(await listSnapshotColumns(env, 'cloud-nobody')).toEqual([]);
    });

    it('degrades a corrupt snapshot_json to no columns instead of throwing', async () => {
      await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
      await env.DB.prepare(`UPDATE risk_snapshots SET snapshot_json = '{oops' WHERE board_id = 5`)
        .bind()
        .run();
      expect(await listSnapshotColumns(env, CLOUD)).toEqual([
        { boardId: 5, columns: [], computedAt: '2026-07-01T10:00:00.000Z' },
      ]);
    });
  });

  // The whole-snapshot read the impact preview re-scores. Same one query, same
  // tolerance for a corrupt row.
  describe('listSnapshots', () => {
    it('returns whole snapshots, scoped to the org', async () => {
      await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
      await overwriteSnapshot(env, OTHER, snapshot(77, '2026-07-01T10:02:00.000Z'));

      const mine = await listSnapshots(env, CLOUD);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.snapshot?.boardId).toBe(5);
      expect(mine[0]?.snapshot?.cutoffs).toEqual(DEFAULT_CUTOFFS);
      expect((await listSnapshots(env, OTHER)).map((r) => r.boardId)).toEqual([77]);
      expect(await listSnapshots(env, 'cloud-nobody')).toEqual([]);
    });

    it('degrades a corrupt snapshot_json to null instead of throwing', async () => {
      await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
      await env.DB.prepare(`UPDATE risk_snapshots SET snapshot_json = '{oops' WHERE board_id = 5`)
        .bind()
        .run();
      expect(await listSnapshots(env, CLOUD)).toEqual([
        { boardId: 5, snapshot: null, computedAt: '2026-07-01T10:00:00.000Z' },
      ]);
    });
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
    await claimDegradedNotice(env, CLOUD, 'errors', null, AT); // an episode was open

    await riskEraseAccount(env, 'acct-refresher');

    const erased = await getConfig(env, CLOUD);
    expect(erased?.refresherAccountId).toBeNull();
    // A fresh episode: whatever was announced before, this cause is new.
    expect(erased?.degradedNotifiedAt).toBeNull();
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
