// Risk-board HTTP handlers, in two dispatchers so index.ts gains only two lines
// (see the plan's deletion story). The authed tier serves STORED snapshots — zero
// Jira calls on the read path; the admin tier owns the per-org config and the live
// Jira pickers.
//
// PRIVACY NOTE (read before assuming this touches the invariant): the snapshot
// shows per-ticket / per-assignee JIRA data that every member of the org can
// already see in Jira. It is NOT self-rated effort. The privacy invariant in
// db/dao.ts guards effort ratings, and neither dao.ts nor privacy.test.ts is
// involved here. Org scoping is still enforced everywhere via ctx.cloudId: a
// board that isn't in the caller's org config 404s.

import type {
  PutRiskAlertPrefsRequest,
  PutRiskConfigRequest,
  RiskAdminConfigResponse,
  RiskAlertPrefs,
  RiskBoardCandidate,
  RiskBoardCandidatesResponse,
  RiskBoardRef,
  RiskBoardResponse,
  RiskBoardSummary,
  RiskBoardsResponse,
  RiskCompositeConfig,
  RiskCutoffRule,
  RiskCutoffs,
  RiskFieldCandidatesResponse,
  RiskFieldIds,
  RiskMetricId,
  RiskWeekday,
  RiskWorkSchedule,
} from '@shared/risk';
import { type AuthedCtx, error, json, readJson } from '../http';
import { JiraClient } from '../jira/client';
import { listBoards } from '../jira/search';
import { isDevEnv } from '../routes/dev';
import { log } from '../log';
import {
  DEFAULT_COMPOSITE,
  DEFAULT_CUTOFFS,
  DEFAULT_IN_PROGRESS_STATUS,
  DEFAULT_SCHEDULE,
} from './logic/defaults';
import { fetchBoardMaps, listRiskFieldCandidates } from './jira';
import { refreshOrg } from './refresh';
import {
  deleteBoardState,
  getAlertMuted,
  getConfig,
  getSnapshot,
  getState,
  markViewed,
  putConfig,
  setAlertMuted,
} from './store';

// --- Authed tier --------------------------------------------------------------

export async function riskRoutes(
  req: Request,
  ctx: AuthedCtx,
  path: string,
  method: string,
): Promise<Response> {
  if (path === '/api/risk/boards' && method === 'GET') return listRiskBoards(ctx);

  // Per-user opt-out for Phase-2 health nudges. Self-scoped (ctx.accountId) — no id
  // ever crosses the wire, so no privacy surface; risk-owned so it deletes with the
  // feature (store.ts, not dao.ts).
  if (path === '/api/risk/alerts/prefs' && method === 'GET') return getAlertPrefs(ctx);
  if (path === '/api/risk/alerts/prefs' && method === 'PUT') return putAlertPrefs(req, ctx);

  const boardMatch = path.match(/^\/api\/risk\/board\/([^/]+)$/);
  if (boardMatch && method === 'GET') return getRiskBoard(ctx, boardMatch[1]!);

  // Dev-only: the cron doesn't tick under plain `wrangler dev`, so this forces one
  // refresh of the caller's org. 404s anywhere but localhost (same guard as
  // routes/dev.ts).
  if (path === '/api/__dev/risk/refresh' && method === 'POST') {
    if (!isDevEnv(ctx.env)) return error(404, 'not found');
    return devRefresh(ctx);
  }

  return error(404, 'not found');
}

/** The org's configured boards with just enough state to render the picker. */
async function listRiskBoards(ctx: AuthedCtx): Promise<Response> {
  const cfg = await getConfig(ctx.env, ctx.cloudId);
  const boards: RiskBoardSummary[] = [];
  for (const b of cfg?.boards ?? []) {
    const [state, snapshot] = await Promise.all([
      getState(ctx.env, ctx.cloudId, b.boardId),
      getSnapshot(ctx.env, ctx.cloudId, b.boardId),
    ]);
    boards.push({
      boardId: b.boardId,
      name: b.name,
      computedAt: snapshot?.computedAt ?? null,
      degradedReason: state?.degradedReason ?? null,
      tierCounts: snapshot?.tierCounts ?? null,
    });
  }
  return json({ boards } satisfies RiskBoardsResponse);
}

/** The stored snapshot. Side effect: records the demand signal the refresh
 *  scheduler uses to pick this board's cadence. */
async function getRiskBoard(ctx: AuthedCtx, rawId: string): Promise<Response> {
  const boardId = Number(rawId);
  if (!Number.isInteger(boardId)) return error(404, 'not found');
  const cfg = await getConfig(ctx.env, ctx.cloudId);
  if (!cfg?.boards.some((b) => b.boardId === boardId)) return error(404, 'not found');

  await markViewed(ctx.env, ctx.cloudId, boardId);
  const [snapshot, state] = await Promise.all([
    getSnapshot(ctx.env, ctx.cloudId, boardId),
    getState(ctx.env, ctx.cloudId, boardId),
  ]);
  const body: RiskBoardResponse = {
    snapshot,
    computedAt: snapshot?.computedAt ?? null,
    degradedReason: state?.degradedReason ?? null,
    refreshing: snapshot === null,
  };
  return json(body);
}

async function devRefresh(ctx: AuthedCtx): Promise<Response> {
  const cfg = await getConfig(ctx.env, ctx.cloudId);
  if (!cfg) return error(409, 'risk board not configured for this site', 'NOT_CONFIGURED');
  await refreshOrg(ctx.env, ctx.dao, cfg, cfg.boards, log);
  return json({ ok: true, boards: cfg.boards.length });
}

/** The caller's own nudge opt-out. Absent row = not muted. */
async function getAlertPrefs(ctx: AuthedCtx): Promise<Response> {
  const muted = await getAlertMuted(ctx.env, ctx.accountId);
  return json({ muted } satisfies RiskAlertPrefs);
}

async function putAlertPrefs(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<PutRiskAlertPrefsRequest>(req);
  if (!body || typeof body.muted !== 'boolean') return error(400, 'muted (boolean) required');
  await setAlertMuted(ctx.env, ctx.accountId, body.muted);
  return json({ muted: body.muted } satisfies RiskAlertPrefs);
}

// --- Admin tier (registered INSIDE index.ts's requireAdmin block) --------------

export async function riskAdminRoutes(
  req: Request,
  ctx: AuthedCtx,
  path: string,
  method: string,
): Promise<Response> {
  if (path === '/api/admin/risk/config' && method === 'GET') return getRiskConfig(ctx);
  if (path === '/api/admin/risk/config' && method === 'PUT') return putRiskConfig(req, ctx);
  if (path === '/api/admin/risk/boards' && method === 'GET') return listBoardCandidates(req, ctx);
  if (path === '/api/admin/risk/fields' && method === 'GET') return listRiskFields(ctx);
  return error(404, 'not found');
}

const DEFAULTS: RiskAdminConfigResponse['defaults'] = {
  cutoffs: DEFAULT_CUTOFFS,
  composite: DEFAULT_COMPOSITE,
  schedule: DEFAULT_SCHEDULE,
  inProgressStatus: DEFAULT_IN_PROGRESS_STATUS,
};

/** Nothing here is secret (board ids, cutoff tables, an account id), so unlike the
 *  notification-channel config the stored values ARE readable back. */
async function getRiskConfig(ctx: AuthedCtx): Promise<Response> {
  const cfg = await getConfig(ctx.env, ctx.cloudId);
  const body: RiskAdminConfigResponse = {
    config: cfg
      ? {
          boards: cfg.boards,
          cutoffs: cfg.cutoffs,
          composite: cfg.composite,
          schedule: cfg.schedule,
          fields: cfg.fields,
          inProgressStatus: cfg.inProgressStatus,
          refresherAccountId: cfg.refresherAccountId,
          devStatusAvailable: cfg.devStatusAvailable,
          configuredBy: cfg.configuredBy,
          updatedAt: cfg.updatedAt,
        }
      : {
          boards: [],
          cutoffs: null,
          composite: null,
          schedule: null,
          fields: {},
          inProgressStatus: null,
          refresherAccountId: null,
          devStatusAvailable: null,
          configuredBy: null,
          updatedAt: null,
        },
    defaults: DEFAULTS,
  };
  return json(body);
}

async function putRiskConfig(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<PutRiskConfigRequest>(req);
  if (!body || !Array.isArray(body.boards)) return error(400, 'boards[] required');

  const boards: RiskBoardRef[] = [];
  for (const b of body.boards) {
    if (!b || !Number.isInteger(b.boardId) || typeof b.name !== 'string' || !b.name.trim()) {
      return error(400, 'each board needs an integer boardId and a name');
    }
    boards.push({ boardId: b.boardId, name: b.name.trim() });
  }

  const cutoffs = body.cutoffs ?? null;
  if (cutoffs && !validCutoffs(cutoffs)) return error(400, 'invalid cutoffs');
  const composite = body.composite ?? null;
  if (composite && !validComposite(composite)) return error(400, 'invalid composite config');
  const schedule = body.schedule ?? null;
  if (schedule) {
    const bad = scheduleError(schedule);
    if (bad) return error(400, bad);
  }
  const fields = body.fields ?? {};
  if (!validFields(fields)) return error(400, 'invalid field ids');

  const existing = await getConfig(ctx.env, ctx.cloudId);
  // Default the refresher to whoever configured it first (mirrors configureChannel's
  // audit pattern); an explicit choice always wins.
  const refresherAccountId =
    body.refresherAccountId ?? existing?.refresherAccountId ?? ctx.accountId;
  if (!(await ctx.dao.getToken(refresherAccountId))) {
    return error(400, 'the refresher account has no Jira grant', 'NO_GRANT');
  }
  // ...and the grant must actually reach THIS site, or the org would degrade five
  // ticks later with no hint why (plan risk #7: surface it at config time).
  if (!(await ctx.dao.accountHasSite(refresherAccountId, ctx.cloudId))) {
    return error(400, 'the refresher account has no access to this site', 'NOT_IN_ORG');
  }

  await putConfig(ctx.env, {
    cloudId: ctx.cloudId,
    boards,
    cutoffs,
    composite,
    schedule,
    fields,
    inProgressStatus: body.inProgressStatus?.trim() || null,
    devStatusAvailable: existing?.devStatusAvailable ?? null,
    refresherAccountId,
    configuredBy: ctx.accountId,
  });

  // Boards dropped from the config take their snapshot + refresh state with them.
  for (const old of existing?.boards ?? []) {
    if (!boards.some((b) => b.boardId === old.boardId)) {
      await deleteBoardState(ctx.env, ctx.cloudId, old.boardId);
    }
  }
  return json({ ok: true });
}

/** Live board list for the picker, using the ADMIN'S own token. `?probe=<id>` also
 *  runs PROBE #1 (board configuration) so a scope problem surfaces here — at
 *  config time — rather than silently in the cron. */
async function listBoardCandidates(req: Request, ctx: AuthedCtx): Promise<Response> {
  const token = await ctx.dao.getToken(ctx.accountId);
  if (!token) return error(409, 'no Jira grant for this admin', 'NO_GRANT');
  const client = new JiraClient(ctx.env, ctx.dao, token, ctx.cloudId);
  const boards: RiskBoardCandidate[] = (await listBoards(client)).map((b) => ({
    boardId: b.id,
    name: b.name,
    type: b.type ?? null,
  }));

  let probeError: string | null = null;
  const probe = new URL(req.url).searchParams.get('probe');
  if (probe && Number.isInteger(Number(probe))) {
    try {
      await fetchBoardMaps(client, Number(probe));
    } catch (e) {
      probeError = e instanceof Error ? e.message : 'board configuration probe failed';
    }
  }
  return json({ boards, probeError } satisfies RiskBoardCandidatesResponse);
}

async function listRiskFields(ctx: AuthedCtx): Promise<Response> {
  const token = await ctx.dao.getToken(ctx.accountId);
  if (!token) return error(409, 'no Jira grant for this admin', 'NO_GRANT');
  const client = new JiraClient(ctx.env, ctx.dao, token, ctx.cloudId);
  const candidates = await listRiskFieldCandidates(client);
  const cfg = await getConfig(ctx.env, ctx.cloudId);
  const body: RiskFieldCandidatesResponse = { ...candidates, current: cfg?.fields ?? {} };
  return json(body);
}

// --- Validation ---------------------------------------------------------------

const WEEKDAYS: RiskWeekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const METRIC_IDS: RiskMetricId[] = ['rejections', 'blocked', 'idle', 'timeInColumn', 'cycle'];

/** Shape AND bounds. A zero/NaN `risk` would divide every score by zero — the
 *  snapshot then serializes `Infinity` as `null` and the whole board silently
 *  scores as nothing, so reject it here instead. */
function validRule(r: RiskCutoffRule): boolean {
  if (!r || typeof r !== 'object') return false;
  if (r.column !== undefined && typeof r.column !== 'string') return false;
  if (r.size !== undefined && r.size !== 'none' && typeof r.size !== 'number') return false;
  if (r.warn !== undefined && !(Number.isFinite(r.warn) && r.warn > 0)) return false;
  if (r.risk !== undefined && !(Number.isFinite(r.risk) && r.risk > 0)) return false;
  if (r.warn !== undefined && r.risk !== undefined && r.risk < r.warn) return false;
  if (r.default !== undefined && typeof r.default !== 'boolean') return false;
  return true;
}

function validCutoffs(c: RiskCutoffs): boolean {
  return (['idle', 'cycle', 'timeInColumn'] as const).every(
    (k) => Array.isArray(c[k]) && c[k].every(validRule),
  );
}

function validComposite(c: RiskCompositeConfig): boolean {
  if (!Number.isFinite(c.p) || !(c.p > 0)) return false;
  if (!c.weights || typeof c.weights !== 'object') return false;
  return Object.entries(c.weights).every(
    ([k, v]) => METRIC_IDS.includes(k as RiskMetricId) && typeof v === 'number' && v >= 0,
  );
}

/** Returns a human message, or null when the schedule is usable. A bad timezone
 *  throws inside Intl.DateTimeFormat — better to find that out here than in cron. */
function scheduleError(s: RiskWorkSchedule): string | null {
  if (typeof s.timeZone !== 'string' || !s.timeZone) return 'schedule.timeZone required';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s.timeZone });
  } catch {
    return `unknown timezone: ${s.timeZone}`;
  }
  if (!s.days || typeof s.days !== 'object') return 'schedule.days required';
  for (const key of Object.keys(s.days)) {
    if (!WEEKDAYS.includes(key as RiskWeekday)) return `unknown day: ${key}`;
  }
  for (const day of WEEKDAYS) {
    const w = s.days[day];
    if (w === null || w === undefined) continue;
    if (!Array.isArray(w) || w.length !== 2) return `schedule.days.${day} must be [open, close]`;
    const [open, close] = w;
    if (typeof open !== 'number' || typeof close !== 'number') {
      return `schedule.days.${day} hours must be numbers`;
    }
    if (!(open >= 0 && close <= 24 && close > open)) {
      return `schedule.days.${day} must satisfy 0 <= open < close <= 24`;
    }
  }
  return null;
}

function validFields(f: RiskFieldIds): boolean {
  return Object.values(f).every((v) => v === null || v === undefined || typeof v === 'string');
}
