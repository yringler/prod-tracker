// Risk-board routes: the read path (stored snapshots, zero Jira calls) and the
// admin config path (validation + defaults echo). Handlers are called directly,
// like admin-notifications.test.ts; the two tests at the bottom go through the
// real worker entry point instead, to prove the registration lines in index.ts
// (including that the admin tier sits inside the requireAdmin block).
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  RiskAdminConfigResponse,
  RiskBoardResponse,
  RiskBoardsResponse,
  PutRiskConfigRequest,
} from '@shared/risk';
import worker from '../src/index';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import { riskAdminRoutes, riskRoutes } from '../src/risk/routes';
import { getSnapshot, getState, markDegraded, overwriteSnapshot, putConfig } from '../src/risk/store';
import { DEFAULT_COMPOSITE, DEFAULT_CUTOFFS, DEFAULT_SCHEDULE } from '../src/risk/logic/defaults';
import { SqliteD1 } from './support/sqlite-d1';

const CLOUD = 'cloud-1';
const ADMIN = 'acct-admin';
const DEV = 'acct-dev';

let db: SqliteD1;
let dao: Dao;
let env: Env;

beforeEach(async () => {
  db = new SqliteD1();
  dao = new Dao(db);
  env = { DB: db, APP_ORIGIN: 'https://app.example' } as unknown as Env;
  await dao.upsertToken({
    accountId: ADMIN,
    refreshToken: 'rt',
    accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  // The refresher must be reachable on THIS site (user_sites is the org boundary).
  await dao.upsertSite(ADMIN, { cloudId: CLOUD, name: 'Site', siteUrl: 'https://site' });
});

function ctxFor(accountId: string): AuthedCtx {
  return { accountId, cloudId: CLOUD, sid: 'sid', dao, env };
}

const snapshot = (boardId: number, computedAt: string) => ({
  boardId,
  boardName: 'Sites',
  columns: ['To Do', 'Done'],
  tickets: [],
  tierCounts: { risk: 2, warn: 1, ok: 3 },
  cutoffs: DEFAULT_CUTOFFS,
  composite: DEFAULT_COMPOSITE,
  schedule: DEFAULT_SCHEDULE,
  computedAt,
});

async function seedConfig(boards = [{ boardId: 5, name: 'Sites' }]): Promise<void> {
  await putConfig(env, {
    cloudId: CLOUD,
    boards,
    cutoffs: null,
    composite: null,
    schedule: null,
    fields: {},
    inProgressStatus: null,
    devStatusAvailable: null,
    refresherAccountId: ADMIN,
    configuredBy: ADMIN,
  });
}

const get = (path: string) =>
  riskRoutes(new Request(`https://app.example${path}`), ctxFor(DEV), path, 'GET');

describe('GET /api/risk/boards', () => {
  it('lists the org’s boards with snapshot freshness and tier counts', async () => {
    await seedConfig();
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));

    const body = (await (await get('/api/risk/boards')).json()) as RiskBoardsResponse;
    expect(body.boards).toEqual([
      {
        boardId: 5,
        name: 'Sites',
        computedAt: '2026-07-01T10:00:00.000Z',
        degradedReason: null,
        tierCounts: { risk: 2, warn: 1, ok: 3 },
      },
    ]);
  });

  it('is empty for an unconfigured org', async () => {
    const body = (await (await get('/api/risk/boards')).json()) as RiskBoardsResponse;
    expect(body.boards).toEqual([]);
  });
});

describe('GET /api/risk/board/:id', () => {
  it('serves the stored snapshot and records the demand signal', async () => {
    await seedConfig();
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));

    const res = await get('/api/risk/board/5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RiskBoardResponse;
    expect(body.snapshot?.boardId).toBe(5);
    expect(body.computedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(body.refreshing).toBe(false);
    expect((await getState(env, CLOUD, 5))?.lastViewedAt).toBeTruthy();
  });

  it('reports refreshing while no snapshot exists yet', async () => {
    await seedConfig();
    const body = (await (await get('/api/risk/board/5')).json()) as RiskBoardResponse;
    expect(body).toMatchObject({ snapshot: null, computedAt: null, refreshing: true });
    // Viewing still registers demand, so the cron picks the board up next tick.
    expect((await getState(env, CLOUD, 5))?.lastViewedAt).toBeTruthy();
  });

  it('404s a board that is not in this org’s config', async () => {
    await seedConfig();
    expect((await get('/api/risk/board/6')).status).toBe(404);
    expect((await get('/api/risk/board/abc')).status).toBe(404);
  });

  it('surfaces a degraded refresher', async () => {
    await seedConfig();
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
    await markDegraded(env, CLOUD, 5, 'needs_reauth');
    // markViewed must not clear the flag.
    const body = (await (await get('/api/risk/board/5')).json()) as RiskBoardResponse;
    expect(body.degradedReason).toBe('needs_reauth');
  });
});

describe('admin config', () => {
  const put = (body: unknown) =>
    riskAdminRoutes(
      new Request('https://app.example/api/admin/risk/config', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
      ctxFor(ADMIN),
      '/api/admin/risk/config',
      'PUT',
    );
  const getConfigRes = () =>
    riskAdminRoutes(
      new Request('https://app.example/api/admin/risk/config'),
      ctxFor(ADMIN),
      '/api/admin/risk/config',
      'GET',
    );

  it('echoes the code defaults alongside an empty config', async () => {
    const body = (await (await getConfigRes()).json()) as RiskAdminConfigResponse;
    expect(body.config.boards).toEqual([]);
    expect(body.config.refresherAccountId).toBeNull();
    expect(body.defaults.cutoffs).toEqual(DEFAULT_CUTOFFS);
    expect(body.defaults.schedule).toEqual(DEFAULT_SCHEDULE);
    expect(body.defaults.inProgressStatus).toBe('In Progress');
  });

  it('saves a config and defaults the refresher to the configuring admin', async () => {
    const res = await put({ boards: [{ boardId: 5, name: 'Sites' }] } satisfies PutRiskConfigRequest);
    expect(res.status).toBe(200);
    const body = (await (await getConfigRes()).json()) as RiskAdminConfigResponse;
    expect(body.config.refresherAccountId).toBe(ADMIN);
    expect(body.config.configuredBy).toBe(ADMIN);
  });

  it('rejects malformed input', async () => {
    expect((await put({})).status).toBe(400); // no boards[]
    expect((await put({ boards: [{ boardId: 'five', name: 'x' }] })).status).toBe(400);
    expect((await put({ boards: [], composite: { p: 0, weights: {} } })).status).toBe(400);
    expect(
      (await put({ boards: [], cutoffs: { idle: [{ warn: 'soon' }], cycle: [], timeInColumn: [] } }))
        .status,
    ).toBe(400);
  });

  it('rejects an unknown timezone before it can break the cron', async () => {
    const res = await put({
      boards: [],
      schedule: { ...DEFAULT_SCHEDULE, timeZone: 'Mars/Olympus_Mons' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'unknown timezone: Mars/Olympus_Mons',
    });
  });

  it('rejects an impossible working day', async () => {
    const res = await put({
      boards: [],
      schedule: { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days, Mon: [18, 9] } },
    });
    expect(res.status).toBe(400);
  });

  it('rejects cutoffs whose thresholds could not band anything', async () => {
    // risk: 0 would divide every score by zero -> Infinity -> null in the snapshot.
    const zeroRisk = await put({
      boards: [],
      cutoffs: { idle: [{ default: true, warn: 10, risk: 0 }], cycle: [], timeInColumn: [] },
    });
    expect(zeroRisk.status).toBe(400);
    // An inverted pair can never produce a 'warn' band.
    const inverted = await put({
      boards: [],
      cutoffs: { idle: [{ default: true, warn: 40, risk: 10 }], cycle: [], timeInColumn: [] },
    });
    expect(inverted.status).toBe(400);
    // The sane pair still saves.
    expect(
      (
        await put({
          boards: [],
          cutoffs: { idle: [{ default: true, warn: 10, risk: 40 }], cycle: [], timeInColumn: [] },
        })
      ).status,
    ).toBe(200);
  });

  it('refuses a refresher with no Jira grant', async () => {
    const res = await put({ boards: [], refresherAccountId: 'acct-nobody' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('NO_GRANT');
  });

  it('refuses a refresher whose grant cannot reach this site', async () => {
    await dao.upsertToken({
      accountId: 'acct-elsewhere',
      refreshToken: 'rt',
      accessToken: 'at',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await dao.upsertSite('acct-elsewhere', {
      cloudId: 'cloud-other',
      name: 'Other',
      siteUrl: 'https://other',
    });
    const res = await put({ boards: [], refresherAccountId: 'acct-elsewhere' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_IN_ORG');
  });

  it('drops the snapshot + state of a board removed from the config', async () => {
    await seedConfig();
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
    await put({ boards: [{ boardId: 9, name: 'Comms' }] });
    expect(await getSnapshot(env, CLOUD, 5)).toBeNull();
    expect(await getState(env, CLOUD, 5)).toBeNull();
  });
});

describe('org isolation', () => {
  it('never leaks another org’s board or snapshot', async () => {
    const OTHER = 'cloud-2';
    await seedConfig();
    await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
    await putConfig(env, {
      cloudId: OTHER,
      boards: [{ boardId: 77, name: 'Theirs' }],
      cutoffs: null,
      composite: null,
      schedule: null,
      fields: {},
      inProgressStatus: null,
      devStatusAvailable: null,
      refresherAccountId: ADMIN,
      configuredBy: ADMIN,
    });
    await overwriteSnapshot(env, OTHER, snapshot(77, '2026-07-01T11:00:00.000Z'));

    const otherCtx: AuthedCtx = { accountId: DEV, cloudId: OTHER, sid: 'sid', dao, env };
    const asOther = (path: string) =>
      riskRoutes(new Request(`https://app.example${path}`), otherCtx, path, 'GET');

    // Org B sees only its own board...
    const list = (await (await asOther('/api/risk/boards')).json()) as RiskBoardsResponse;
    expect(list.boards.map((b) => b.boardId)).toEqual([77]);
    // ...and org A's board id is simply not found for it (and vice versa).
    expect((await asOther('/api/risk/board/5')).status).toBe(404);
    expect((await get('/api/risk/board/77')).status).toBe(404);
    // A 404 must not have recorded a demand signal for someone else's board.
    expect(await getState(env, OTHER, 5)).toBeNull();
  });
});

describe('router wiring (worker entry point)', () => {
  async function fetchAs(accountId: string, path: string, method = 'GET'): Promise<Response> {
    const sid = await dao.createSession(accountId, CLOUD, 3600);
    return worker.fetch(
      new Request(`https://app.example${path}`, { method, headers: { Cookie: `sid=${sid}` } }),
      env,
    );
  }

  it('routes /api/risk/* for any authenticated member', async () => {
    await seedConfig();
    expect((await fetchAs(DEV, '/api/risk/boards')).status).toBe(200);
    expect((await fetchAs(DEV, '/api/risk/board/5')).status).toBe(200);
  });

  it('gates /api/admin/risk/* behind requireAdmin', async () => {
    expect((await fetchAs(DEV, '/api/admin/risk/config')).status).toBe(403);
    await dao.appointAdmin(ADMIN, ADMIN);
    expect((await fetchAs(ADMIN, '/api/admin/risk/config')).status).toBe(200);
  });

  it('404s the dev-only refresh route outside localhost', async () => {
    await seedConfig();
    expect((await fetchAs(ADMIN, '/api/__dev/risk/refresh', 'POST')).status).toBe(404);
  });
});
