// The impact preview: POST /api/admin/risk/preview re-scores each board's STORED
// snapshot under a candidate config, so an admin sees "12 risk / 9 warn / 40 ok
// (was 6 / 8 / 47)" BEFORE saving.
//
// The two properties worth protecting here are (a) it spends ZERO Jira calls — it
// is a pure re-run of the cron's own scorer over stored tickets — and (b) it
// validates the candidate exactly as the save does, so it can never preview a
// config that wouldn't store.
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  RiskBoardSnapshot,
  RiskCompositeConfig,
  RiskConfigIssue,
  RiskCutoffs,
  RiskPreviewRequest,
  RiskPreviewResponse,
  RiskTicket,
  RiskWorkSchedule,
} from '@shared/risk';
import worker from '../src/index';
import { Dao } from '../src/db/dao';
import type { Env } from '../src/env';
import type { AuthedCtx } from '../src/http';
import { riskAdminRoutes } from '../src/risk/routes';
import { overwriteSnapshot, putConfig } from '../src/risk/store';
import { evaluateTicket } from '../src/risk/logic/health';
import { PREVIEW_SAMPLE_LIMIT, sameSchedule } from '../src/risk/logic/preview';
import {
  DEFAULT_COMPOSITE,
  DEFAULT_CUTOFFS,
  DEFAULT_SCHEDULE,
} from '../src/risk/logic/defaults';
import { SqliteD1 } from './support/sqlite-d1';

const CLOUD = 'cloud-1';
const ADMIN = 'acct-admin';
const DEV = 'acct-dev';
const COLUMNS = ['To Do', 'In Progress', 'Done'];

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
  await dao.upsertSite(ADMIN, { cloudId: CLOUD, name: 'Site', siteUrl: 'https://site' });
});

function ctxFor(accountId: string): AuthedCtx {
  return { accountId, cloudId: CLOUD, sid: 'sid', dao, env };
}

// --- Fixtures ----------------------------------------------------------------

/** Only the idle metric is scored, so the fixture's tiers are readable by eye. */
const ONLY_IDLE: RiskCompositeConfig = {
  p: 1,
  weights: { rejections: 0, blocked: 0, idle: 1, timeInColumn: 0, cycle: 0 },
};
const STORED_CUTOFFS: RiskCutoffs = {
  idle: [{ default: true, warn: 24, risk: 72 }],
  timeInColumn: [{ default: true, warn: 24, risk: 56 }],
  cycle: [{ default: true, warn: 19, risk: 32 }],
};

interface Raw {
  key: string;
  column?: string;
  points?: number | null;
  idleHours?: number | null;
  timeInColumnHours?: number | null;
  cycleHours?: number | null;
  started?: boolean;
}

/** A full RiskTicket whose STORED tier is computed by the real scorer under
 *  `cutoffs`/`composite` — the same path the cron takes, so "before" in the
 *  preview is exactly what /risk shows today. */
function ticket(raw: Raw, cutoffs: RiskCutoffs, composite: RiskCompositeConfig): RiskTicket {
  const input = {
    column: raw.column ?? 'In Progress',
    points: raw.points ?? null,
    rejections: 0,
    blocked: false,
    started: raw.started ?? true,
    idleHours: raw.idleHours ?? null,
    timeInColumnHours: raw.timeInColumnHours ?? null,
    cycleHours: raw.cycleHours ?? null,
  };
  const health = evaluateTicket(input, cutoffs, composite, COLUMNS);
  return {
    key: raw.key,
    summary: `${raw.key} summary`,
    type: 'Task',
    status: input.column,
    column: input.column,
    assignee: null,
    avatarUrl: null,
    points: input.points,
    parentKey: null,
    implementor: null,
    codeReviewer: null,
    rejections: input.rejections,
    blocked: input.blocked,
    blockedByOpen: [],
    unassignedInProgress: false,
    done: input.column === 'Done',
    started: input.started,
    idleHours: input.idleHours,
    timeInColumnHours: input.timeInColumnHours,
    cycleHours: input.cycleHours,
    metrics: health.metrics,
    composite: health.composite,
    tier: health.tier,
    columnTotals: [],
    flow: { createdAt: '2026-07-01T00:00:00.000Z', startedAt: null, columnSegs: [], assigneeSegs: [], totalHours: 0 },
    recentUpdaters: [],
  };
}

function snapshotOf(
  boardId: number,
  raws: Raw[],
  opts: {
    cutoffs?: RiskCutoffs;
    composite?: RiskCompositeConfig;
    schedule?: RiskWorkSchedule;
  } = {},
): RiskBoardSnapshot {
  const cutoffs = opts.cutoffs ?? STORED_CUTOFFS;
  const composite = opts.composite ?? ONLY_IDLE;
  const tickets = raws.map((r) => ticket(r, cutoffs, composite));
  return {
    boardId,
    boardName: `Board ${boardId}`,
    columns: COLUMNS,
    tickets,
    tierCounts: { risk: 0, warn: 0, ok: 0 }, // deliberately wrong: the preview recomputes
    cutoffs,
    composite,
    schedule: opts.schedule ?? DEFAULT_SCHEDULE,
    computedAt: '2026-07-01T10:00:00.000Z',
  };
}

async function seedConfig(boards: { boardId: number; name: string }[]): Promise<void> {
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

const PATH = '/api/admin/risk/preview';

function preview(body: unknown, accountId = ADMIN): Promise<Response> {
  return riskAdminRoutes(
    new Request(`https://app.example${PATH}`, { method: 'POST', body: JSON.stringify(body) }),
    ctxFor(accountId),
    PATH,
    'POST',
  );
}

async function previewOk(body: RiskPreviewRequest): Promise<RiskPreviewResponse> {
  // Any Jira traffic would go through global fetch; make that fatal, since
  // "zero Jira calls" is the property that makes this endpoint keystroke-cheap.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('no Jira call may happen on the preview path');
  }) as typeof fetch;
  try {
    const res = await preview(body);
    expect(res.status).toBe(200);
    return (await res.json()) as RiskPreviewResponse;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- Tests -------------------------------------------------------------------

describe('POST /api/admin/risk/preview', () => {
  it('re-scores the stored snapshot: known cutoffs change, known before/after', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    await overwriteSnapshot(
      env,
      CLOUD,
      snapshotOf(5, [
        { key: 'A-1', idleHours: 10 }, // ok  under 24/72
        { key: 'B-2', idleHours: 30 }, // warn
        { key: 'C-3', idleHours: 100 }, // risk
        { key: 'D-4', column: 'Done', idleHours: 100 }, // done: no tier, never counted
      ]),
    );

    const body = await previewOk({
      cutoffs: { ...STORED_CUTOFFS, idle: [{ default: true, warn: 5, risk: 20 }] },
      composite: ONLY_IDLE,
      schedule: DEFAULT_SCHEDULE,
    });

    const board = body.boards[0]!;
    expect(board.status).toBe('previewed');
    expect(board.before).toEqual({ risk: 1, warn: 1, ok: 1 });
    expect(board.after).toEqual({ risk: 2, warn: 1, ok: 0 });
    expect(board.movedToRisk).toBe(1); // B-2: warn -> risk
    expect(board.movedToOk).toBe(0);
    expect(board.moved).toBe(2); // + A-1: ok -> warn
    expect(board.sampleMovers.map((m) => m.key).sort()).toEqual(['A-1', 'B-2']);
    expect(board.sampleMovers.find((m) => m.key === 'B-2')).toMatchObject({
      from: 'warn',
      to: 'risk',
      summary: 'B-2 summary',
    });
    expect(board.sampleTruncated).toBe(false);
    expect(board.computedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(body.totals).toEqual({
      before: { risk: 1, warn: 1, ok: 1 },
      after: { risk: 2, warn: 1, ok: 0 },
      movedToRisk: 1,
      movedToOk: 0,
      moved: 2,
    });
  });

  it('counts the improving direction too', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    await overwriteSnapshot(
      env,
      CLOUD,
      snapshotOf(5, [
        { key: 'A-1', idleHours: 10 },
        { key: 'B-2', idleHours: 30 },
        { key: 'C-3', idleHours: 100 },
      ]),
    );

    const body = await previewOk({
      // Loosen everything: nothing fires any more.
      cutoffs: { ...STORED_CUTOFFS, idle: [{ default: true, warn: 500, risk: 1000 }] },
      composite: ONLY_IDLE,
      schedule: DEFAULT_SCHEDULE,
    });
    expect(body.boards[0]).toMatchObject({
      before: { risk: 1, warn: 1, ok: 1 },
      after: { risk: 0, warn: 0, ok: 3 },
      movedToRisk: 0,
      movedToOk: 2,
      moved: 2,
    });
  });

  it('reports no change when the candidate IS the stored config', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    await overwriteSnapshot(
      env,
      CLOUD,
      snapshotOf(5, [
        { key: 'A-1', idleHours: 10 },
        { key: 'B-2', idleHours: 30 },
      ]),
    );
    const body = await previewOk({
      cutoffs: STORED_CUTOFFS,
      composite: ONLY_IDLE,
      schedule: DEFAULT_SCHEDULE,
    });
    expect(body.boards[0]?.moved).toBe(0);
    expect(body.boards[0]?.before).toEqual(body.boards[0]?.after);
    expect(body.boards[0]?.sampleMovers).toEqual([]);
  });

  it('caps the sample list and SAYS it capped it', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    const many = Array.from({ length: PREVIEW_SAMPLE_LIMIT + 4 }, (_, i) => ({
      key: `X-${i}`,
      idleHours: 10,
    }));
    await overwriteSnapshot(env, CLOUD, snapshotOf(5, many));

    const body = await previewOk({
      cutoffs: { ...STORED_CUTOFFS, idle: [{ default: true, warn: 5, risk: 8 }] },
      composite: ONLY_IDLE,
      schedule: DEFAULT_SCHEDULE,
    });
    const board = body.boards[0]!;
    expect(board.moved).toBe(PREVIEW_SAMPLE_LIMIT + 4);
    expect(board.sampleMovers).toHaveLength(PREVIEW_SAMPLE_LIMIT);
    expect(board.sampleTruncated).toBe(true);
    expect(body.sampleLimit).toBe(PREVIEW_SAMPLE_LIMIT);
  });

  it('previews the SHIPPED DEFAULTS for cutoffs: null — not the hard floor', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    // Stored with the shipped defaults, so "null" must reproduce the board exactly.
    // A 40h cycle is 'risk' under the default table (19/32) and 'ok' under the
    // HARD_FALLBACK floor (160/240) — which is what a naive `resolveCutoff(null)`
    // would give.
    await overwriteSnapshot(
      env,
      CLOUD,
      snapshotOf(5, [{ key: 'A-1', cycleHours: 40, idleHours: 1, timeInColumnHours: 1 }], {
        cutoffs: DEFAULT_CUTOFFS,
        composite: DEFAULT_COMPOSITE,
      }),
    );

    const inherited = await previewOk({ cutoffs: null, composite: null, schedule: null });
    expect(inherited.boards[0]?.before).toEqual({ risk: 1, warn: 0, ok: 0 });
    expect(inherited.boards[0]?.after).toEqual({ risk: 1, warn: 0, ok: 0 });
    expect(inherited.boards[0]?.moved).toBe(0);

    // ...and a table with no matching cycle rule really does fall to the floor,
    // which is the behaviour `null` must NOT have.
    const floored = await previewOk({
      cutoffs: { idle: DEFAULT_CUTOFFS.idle, timeInColumn: DEFAULT_CUTOFFS.timeInColumn, cycle: [] },
      composite: null,
      schedule: null,
    });
    expect(floored.boards[0]?.after).toEqual({ risk: 0, warn: 0, ok: 1 });
  });

  it('flags a schedule change as stale instead of pretending to simulate it', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    await overwriteSnapshot(env, CLOUD, snapshotOf(5, [{ key: 'A-1', idleHours: 10 }]));

    const same = await previewOk({ cutoffs: null, composite: null, schedule: DEFAULT_SCHEDULE });
    expect(same.scheduleStale).toBe(false);
    expect(same.boards[0]?.scheduleStale).toBe(false);

    const changed = await previewOk({
      cutoffs: null,
      composite: null,
      schedule: { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days, Fri: [9, 18] } },
    });
    expect(changed.scheduleStale).toBe(true);
    expect(changed.boards[0]?.scheduleStale).toBe(true);
    // The counts are still the stored-clock ones — the flag is the whole caveat.
    expect(changed.boards[0]?.before).toEqual(same.boards[0]?.before);
  });

  it('degrades a board with no snapshot instead of erroring, and leaves it out of the totals', async () => {
    await seedConfig([
      { boardId: 5, name: 'Sites' },
      { boardId: 9, name: 'Never refreshed' },
    ]);
    await overwriteSnapshot(env, CLOUD, snapshotOf(5, [{ key: 'A-1', idleHours: 100 }]));

    const body = await previewOk({ cutoffs: null, composite: null, schedule: null });
    expect(body.boards).toHaveLength(2);
    expect(body.boards[1]).toMatchObject({
      boardId: 9,
      name: 'Never refreshed',
      status: 'no-snapshot',
      before: { risk: 0, warn: 0, ok: 0 },
      after: { risk: 0, warn: 0, ok: 0 },
      computedAt: null,
    });
    expect(body.boardsWithoutSnapshot).toBe(1);
    // Totals come only from the previewed board (one ticket, not two boards' worth).
    expect(body.totals.before).toEqual({ risk: 1, warn: 0, ok: 0 });
    expect(body.totals.after).toEqual({ risk: 1, warn: 0, ok: 0 });
  });

  it('is empty (not an error) for an org with no risk config at all', async () => {
    const body = await previewOk({ cutoffs: null, composite: null, schedule: null });
    expect(body.boards).toEqual([]);
    expect(body.totals.before).toEqual({ risk: 0, warn: 0, ok: 0 });
    expect(body.boardsWithoutSnapshot).toBe(0);
  });

  it('sums the totals across boards', async () => {
    await seedConfig([
      { boardId: 5, name: 'A' },
      { boardId: 6, name: 'B' },
    ]);
    await overwriteSnapshot(env, CLOUD, snapshotOf(5, [{ key: 'A-1', idleHours: 30 }]));
    await overwriteSnapshot(env, CLOUD, snapshotOf(6, [{ key: 'B-1', idleHours: 30 }]));

    const body = await previewOk({
      cutoffs: { ...STORED_CUTOFFS, idle: [{ default: true, warn: 5, risk: 20 }] },
      composite: ONLY_IDLE,
      schedule: DEFAULT_SCHEDULE,
    });
    expect(body.totals).toEqual({
      before: { risk: 0, warn: 2, ok: 0 },
      after: { risk: 2, warn: 0, ok: 0 },
      movedToRisk: 2,
      movedToOk: 0,
      moved: 2,
    });
  });

  it('never sees another org’s snapshot', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    await overwriteSnapshot(env, 'cloud-2', snapshotOf(5, [{ key: 'Z-1', idleHours: 100 }]));
    const body = await previewOk({ cutoffs: null, composite: null, schedule: null });
    expect(body.boards[0]).toMatchObject({ boardId: 5, status: 'no-snapshot' });
  });

  describe('validation — identical to the save path', () => {
    it('400s an invalid cutoffs table with the same structured issues', async () => {
      await seedConfig([{ boardId: 5, name: 'Sites' }]);
      const res = await preview({
        cutoffs: {
          idle: [{ default: true, warn: 24, risk: 72 }, { column: 'To Do', warn: 4 }],
          cycle: [],
          timeInColumn: [],
        },
        composite: null,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; issues?: RiskConfigIssue[] };
      expect(body.code).toBe('INVALID_CUTOFFS');
      expect(body.issues).toEqual([
        expect.objectContaining({ metric: 'idle', index: 1, field: 'risk', code: 'INCOMPLETE_RULE' }),
      ]);
    });

    it('400s an invalid composite and an unknown timezone', async () => {
      expect((await preview({ cutoffs: null, composite: { p: 0, weights: {} } })).status).toBe(400);
      expect(
        (
          await preview({
            cutoffs: null,
            composite: null,
            schedule: { ...DEFAULT_SCHEDULE, timeZone: 'Mars/Olympus_Mons' },
          })
        ).status,
      ).toBe(400);
    });

    it('lets warnings through — they never block a preview', async () => {
      const res = await preview({
        cutoffs: { idle: [{ column: 'To Do', warn: 1, risk: 2 }], cycle: [], timeInColumn: [] },
        composite: null,
      });
      expect(res.status).toBe(200);
    });
  });

  // The staleness gate itself. It is deliberately structural, not identity-based:
  // the client re-parses its schedule JSON on every keystroke, so a fresh object
  // with identical hours must NOT read as a change.
  describe('sameSchedule', () => {
    it('compares by value, and treats a null day as a real difference', () => {
      expect(sameSchedule(DEFAULT_SCHEDULE, { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } })).toBe(true);
      expect(sameSchedule(DEFAULT_SCHEDULE, { ...DEFAULT_SCHEDULE, timeZone: 'UTC' })).toBe(false);
      expect(
        sameSchedule(DEFAULT_SCHEDULE, {
          ...DEFAULT_SCHEDULE,
          days: { ...DEFAULT_SCHEDULE.days, Fri: null },
        }),
      ).toBe(false);
      expect(
        sameSchedule(DEFAULT_SCHEDULE, {
          ...DEFAULT_SCHEDULE,
          days: { ...DEFAULT_SCHEDULE.days, Mon: [9, 17] },
        }),
      ).toBe(false);
    });

    it('handles a missing schedule without throwing', () => {
      expect(sameSchedule(null, null)).toBe(true);
      expect(sameSchedule(DEFAULT_SCHEDULE, null)).toBe(false);
      expect(sameSchedule(undefined, DEFAULT_SCHEDULE)).toBe(false);
    });
  });

  it('is gated behind requireAdmin', async () => {
    await seedConfig([{ boardId: 5, name: 'Sites' }]);
    const call = async (accountId: string): Promise<number> => {
      const sid = await dao.createSession(accountId, CLOUD, 3600);
      const res = await worker.fetch(
        new Request(`https://app.example${PATH}`, {
          method: 'POST',
          headers: { Cookie: `sid=${sid}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cutoffs: null, composite: null }),
        }),
        env,
      );
      return res.status;
    };
    expect(await call(DEV)).toBe(403);
    await dao.appointAdmin(ADMIN, ADMIN);
    expect(await call(ADMIN)).toBe(200);
  });
});
