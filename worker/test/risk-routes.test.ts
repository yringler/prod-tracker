// Risk-board routes: the read path (stored snapshots, zero Jira calls) and the
// admin config path (validation + defaults echo). Handlers are called directly,
// like admin-notifications.test.ts; the two tests at the bottom go through the
// real worker entry point instead, to prove the registration lines in index.ts
// (including that the admin tier sits inside the requireAdmin block).
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  PutRiskAlertPrefsRequest,
  RiskAdminConfigResponse,
  RiskBoardResponse,
  RiskBoardsResponse,
  RiskColumnsResponse,
  RiskFieldCandidatesResponse,
  RiskConfigIssue,
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
    fields: [],
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

  // The shared validator's findings ride along on the error body so the editor can
  // point at the offending row instead of just saying "invalid cutoffs".
  describe('structured cutoff issues', () => {
    const issuesFor = async (cutoffs: unknown) => {
      const res = await put({ boards: [], cutoffs });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; issues?: RiskConfigIssue[] };
      expect(body.code).toBe('INVALID_CUTOFFS');
      return body.issues ?? [];
    };

    it('names the metric of a missing table', async () => {
      const issues = await issuesFor({ idle: [] });
      expect(issues.map((i) => [i.metric, i.code])).toEqual([
        ['timeInColumn', 'MISSING_METRIC'],
        ['cycle', 'MISSING_METRIC'],
      ]);
    });

    it('addresses a half-filled rule by metric + index + field', async () => {
      const issues = await issuesFor({
        idle: [{ default: true, warn: 24, risk: 72 }, { column: 'To Do', warn: 4 }],
        cycle: [],
        timeInColumn: [],
      });
      expect(issues).toEqual([
        expect.objectContaining({ metric: 'idle', index: 1, field: 'risk', code: 'INCOMPLETE_RULE' }),
      ]);
    });

    it('rejects an off-ladder size and says which bucket it belongs in', async () => {
      const [issue] = await issuesFor({
        idle: [],
        cycle: [{ size: 4, warn: 1, risk: 2 }],
        timeInColumn: [],
      });
      expect(issue).toMatchObject({ metric: 'cycle', index: 0, field: 'size', code: 'NOT_A_BUCKET' });
      expect(issue?.message).toContain('4–5');
    });

    it('rejects a duplicated default and a duplicated scope', async () => {
      const dupDefault = await issuesFor({
        idle: [{ default: true, warn: 1, risk: 2 }, { default: true, warn: 3, risk: 4 }],
        cycle: [],
        timeInColumn: [],
      });
      expect(dupDefault.map((i) => i.code)).toContain('DUPLICATE_DEFAULT');
      const dupScope = await issuesFor({
        idle: [
          { column: 'To Do', warn: 1, risk: 2 },
          { column: 'To Do', warn: 3, risk: 4 },
        ],
        cycle: [],
        timeInColumn: [],
      });
      expect(dupScope.map((i) => i.code)).toContain('DUPLICATE_SCOPE');
    });

    it('lets WARNINGS through — they never block a save', async () => {
      // No default rule (falls to the hard floor) + an unknown key: both warnings.
      const res = await put({
        boards: [],
        cutoffs: { idle: [{ column: 'To Do', warn: 1, risk: 2, colour: 'red' }], cycle: [], timeInColumn: [] },
      });
      expect(res.status).toBe(200);
    });

    it('still stores NULL for cutoffs: null and echoes the shipped defaults', async () => {
      expect((await put({ boards: [], cutoffs: null })).status).toBe(200);
      const body = (await (await getConfigRes()).json()) as RiskAdminConfigResponse;
      expect(body.config.cutoffs).toBeNull();
      expect(body.defaults.cutoffs).toEqual(DEFAULT_CUTOFFS);
    });
  });

  // Same shape for the field-mapping entries: shared validateFieldEntries findings
  // ride the 400 so the Fields panel can point at the offending row.
  describe('structured field-entry issues', () => {
    const fieldIssuesFor = async (fields: unknown) => {
      const res = await put({ boards: [], fields });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; issues?: RiskConfigIssue[] };
      expect(body.code).toBe('INVALID_FIELDS');
      return body.issues ?? [];
    };

    it('rejects a duplicate fieldId, addressed by entry index', async () => {
      const issues = await fieldIssuesFor([
        { label: 'Flagged', fieldId: 'customfield_1', kind: 'flag' },
        { label: 'Also flagged', fieldId: 'customfield_1', kind: 'flag' },
      ]);
      expect(issues).toEqual([
        expect.objectContaining({ index: 1, field: 'fieldId', code: 'DUPLICATE_FIELD_ID' }),
      ]);
    });

    it('rejects a count entry without thresholds, and warn >= risk', async () => {
      const missing = await fieldIssuesFor([
        { label: 'Rejections', fieldId: 'customfield_2', kind: 'count' },
      ]);
      expect(missing.map((i) => i.code)).toEqual(['INVALID_THRESHOLD', 'INVALID_THRESHOLD']);
      const inverted = await fieldIssuesFor([
        { label: 'Rejections', fieldId: 'customfield_2', kind: 'count', warn: 4, risk: 4 },
      ]);
      expect(inverted.map((i) => i.code)).toContain('INVERTED_THRESHOLD');
    });

    it('rejects a flag entry carrying thresholds', async () => {
      const issues = await fieldIssuesFor([
        { label: 'Flagged', fieldId: 'customfield_1', kind: 'flag', warn: 1, risk: 2 },
      ]);
      expect(issues.map((i) => i.code)).toContain('FLAG_WITH_THRESHOLDS');
    });

    it('saves valid entries and echoes them back on GET', async () => {
      const entries = [
        { label: 'Flagged', fieldId: 'customfield_1', kind: 'flag' as const },
        { label: 'Rejections', fieldId: 'customfield_2', kind: 'count' as const, warn: 2, risk: 4, weight: 2 },
      ];
      expect((await put({ boards: [], fields: entries })).status).toBe(200);
      const body = (await (await getConfigRes()).json()) as RiskAdminConfigResponse;
      expect(body.config.fields).toEqual(entries);
    });

    it('400s a legacy composite blob still carrying a rejections weight (release-noted)', async () => {
      const res = await put({
        boards: [],
        composite: { p: 2, weights: { rejections: 1, blocked: 1, idle: 1, timeInColumn: 1, cycle: 1 } },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/admin/risk/columns', () => {
    const columns = async (accountId = ADMIN) =>
      riskAdminRoutes(
        new Request('https://app.example/api/admin/risk/columns'),
        ctxFor(accountId),
        '/api/admin/risk/columns',
        'GET',
      );

    it('prefers the stored snapshot and spends zero Jira calls', async () => {
      await seedConfig();
      await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
      // Any Jira traffic would go through global fetch; make that fatal.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error('no Jira call may happen on this path');
      }) as typeof fetch;
      try {
        const body = (await (await columns()).json()) as RiskColumnsResponse;
        expect(body.boards).toEqual([
          {
            boardId: 5,
            name: 'Sites',
            columns: ['To Do', 'Done'],
            doneColumn: 'Done',
            source: 'snapshot',
          },
        ]);
        expect(body.pointsFieldConfigured).toBe(false); // no field discovered in this fixture
        expect(body.probeError).toBeNull();
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('reports the Story Points field once one is resolved', async () => {
      await seedConfig();
      await overwriteSnapshot(env, CLOUD, snapshot(5, '2026-07-01T10:00:00.000Z'));
      await dao.setFieldIds(CLOUD, 'customfield_100', 'customfield_101');
      const body = (await (await columns()).json()) as RiskColumnsResponse;
      expect(body.pointsFieldConfigured).toBe(true);
    });

    it('falls back to a live probe for a board that has never refreshed, and degrades on failure', async () => {
      await seedConfig();
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response('nope', { status: 403 })) as unknown as typeof fetch;
      try {
        const body = (await (await columns()).json()) as RiskColumnsResponse;
        expect(body.boards[0]).toMatchObject({ boardId: 5, columns: [], source: 'unavailable' });
        expect(body.probeError).toBeTruthy();
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  // The Fields panel's vocabulary. Both halves are live Jira reads with the ADMIN'S
  // token — a field/status list is in no snapshot — but the STATUS half is the one
  // the picker can do without, so it degrades to [] instead of failing the panel.
  describe('GET /api/admin/risk/fields', () => {
    const fields = async (accountId = ADMIN) =>
      riskAdminRoutes(
        new Request('https://app.example/api/admin/risk/fields'),
        ctxFor(accountId),
        '/api/admin/risk/fields',
        'GET',
      );

    const stubJira = (statusRes: () => Response) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/rest/api/3/field')) {
          return Response.json([
            { id: 'customfield_1', name: 'Flagged', schema: { type: 'option' } },
            { id: 'customfield_2', name: 'Rejection count', schema: { type: 'number' } },
            { id: 'labels', name: 'Labels', schema: { type: 'array' } }, // system fields included
            { id: 'issuekey', name: 'Key' }, // no schema at all
            { id: '', name: 'Nameless' }, // malformed -> dropped
          ]);
        }
        if (url.includes('/rest/api/3/status')) return statusRes();
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;
      return () => {
        globalThis.fetch = realFetch;
      };
    };

    const okStatuses = () =>
      Response.json([
        { name: 'Done', statusCategory: { key: 'done' } },
        { name: 'In Review', statusCategory: { key: 'indeterminate' } },
        { name: 'To Do', statusCategory: { key: 'new' } },
        { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        // Jira lists a status once per project that uses it; the config stores a
        // NAME, so the repeat is one choice, not two.
        { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        { name: 'Odd', statusCategory: {} },
      ]);

    it('serves ALL fields (kind from schema.type) and the site statuses, in-progress first', async () => {
      const restore = stubJira(okStatuses);
      try {
        const body = (await (await fields()).json()) as RiskFieldCandidatesResponse;
        // Sorted by name; number -> count, everything else (incl. no schema) -> flag.
        expect(body.fields).toEqual([
          { id: 'customfield_1', name: 'Flagged', schemaType: 'option', kind: 'flag' },
          { id: 'issuekey', name: 'Key', schemaType: null, kind: 'flag' },
          { id: 'labels', name: 'Labels', schemaType: 'array', kind: 'flag' },
          { id: 'customfield_2', name: 'Rejection count', schemaType: 'number', kind: 'count' },
        ]);
        expect(body.current).toEqual([]); // nothing configured yet
        expect(body.statuses).toEqual([
          { name: 'In Progress', category: 'indeterminate' },
          { name: 'In Review', category: 'indeterminate' },
          { name: 'To Do', category: 'new' },
          { name: 'Done', category: 'done' },
          { name: 'Odd', category: 'unknown' },
        ]);
      } finally {
        restore();
      }
    });

    it('echoes the stored entries as `current` (a legacy object row converted)', async () => {
      await seedConfig();
      await env.DB.prepare(`UPDATE risk_board_config SET fields_json = ? WHERE cloud_id = ?`)
        .bind(JSON.stringify({ flagged: 'customfield_1', implementor: 'customfield_9' }), CLOUD)
        .run();
      const restore = stubJira(okStatuses);
      try {
        const body = (await (await fields()).json()) as RiskFieldCandidatesResponse;
        expect(body.current).toEqual([{ label: 'Flagged', fieldId: 'customfield_1', kind: 'flag' }]);
      } finally {
        restore();
      }
    });

    it('degrades the status list to [] rather than failing the panel', async () => {
      const restore = stubJira(() => new Response('nope', { status: 403 }));
      try {
        const res = await fields();
        expect(res.status).toBe(200);
        const body = (await res.json()) as RiskFieldCandidatesResponse;
        expect(body.statuses).toEqual([]);
        expect(body.fields.length).toBeGreaterThan(0);
      } finally {
        restore();
      }
    });
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

describe('alert prefs (self-scoped)', () => {
  const prefsGet = (accountId: string) =>
    riskRoutes(
      new Request('https://app.example/api/risk/alerts/prefs'),
      ctxFor(accountId),
      '/api/risk/alerts/prefs',
      'GET',
    );
  const prefsPut = (accountId: string, body: unknown) =>
    riskRoutes(
      new Request('https://app.example/api/risk/alerts/prefs', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
      ctxFor(accountId),
      '/api/risk/alerts/prefs',
      'PUT',
    );

  it('defaults to unmuted, round-trips the toggle, and stays per-account', async () => {
    expect(await (await prefsGet(DEV)).json()).toEqual({ muted: false });

    const put = await prefsPut(DEV, { muted: true } satisfies PutRiskAlertPrefsRequest);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ muted: true });
    expect(await (await prefsGet(DEV)).json()).toEqual({ muted: true });

    // Another account is unaffected — the route reads/writes ctx.accountId only.
    expect(await (await prefsGet(ADMIN)).json()).toEqual({ muted: false });
  });

  it('rejects a non-boolean muted', async () => {
    expect((await prefsPut(DEV, {})).status).toBe(400);
    expect((await prefsPut(DEV, { muted: 'yes' })).status).toBe(400);
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
      fields: [],
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
    expect((await fetchAs(DEV, '/api/admin/risk/columns')).status).toBe(403);
    await dao.appointAdmin(ADMIN, ADMIN);
    expect((await fetchAs(ADMIN, '/api/admin/risk/config')).status).toBe(200);
    expect((await fetchAs(ADMIN, '/api/admin/risk/columns')).status).toBe(200);
  });

  it('404s the dev-only refresh route outside localhost', async () => {
    await seedConfig();
    expect((await fetchAs(ADMIN, '/api/__dev/risk/refresh', 'POST')).status).toBe(404);
  });
});
