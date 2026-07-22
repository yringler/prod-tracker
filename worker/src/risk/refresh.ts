// The risk board's WRITE path: the 4th isolated cron job. Every tick it picks the
// boards that are due (demand-driven), refreshes them against Jira under a
// per-tick subrequest budget, and OVERWRITES their snapshots. The read route then
// serves stored JSON with zero Jira calls (the load-bearing read/write split).
//
// Shape notes for the next reader:
//   - Selection is fleet-wide and org-fair: eligible boards are ordered by
//     staleness, then round-robin interleaved across orgs, so one org with many
//     boards can't starve another. Whatever fits in the budget runs this tick; the
//     rest is naturally picked up next tick (the pd-report.ts resume pattern).
//   - EXECUTION is grouped back per org: one JiraClient per org, boards serial,
//     `sleep(PACING_MS)` between Jira calls — per-tenant rate limits are per-org,
//     so pacing inside the org loop controls that org's request rate exactly.
//   - `refreshOrg` is deliberately self-contained: if the fleet ever outgrows the
//     cron budget (boards regularly missing cadence / budget consistently
//     exhausted), its body becomes a Queue consumer's per-message handler, one
//     message per org, with no rewrite. That is the documented graduation path.
//   - Overwrite-only writes make the whole job idempotent: re-running a tick
//     produces the same rows.

import type {
  RiskBoardRef,
  RiskBoardSnapshot,
  RiskDegradedReason,
  RiskTicket,
  RiskWorkSchedule,
} from '@shared/risk';
import type { Dao } from '../db/dao';
import type { Env } from '../env';
import { JiraApiError, JiraClient, ReauthRequiredError } from '../jira/client';
import { errFields, log as rootLog, type Logger } from '../log';
import {
  DEFAULT_COMPOSITE,
  DEFAULT_CUTOFFS,
  DEFAULT_IN_PROGRESS_STATUS,
  DEFAULT_SCHEDULE,
} from './logic/defaults';
import { evaluateTicket, tierCounts } from './logic/health';
import { buildSegments } from './logic/segments';
import { recentUpdaters, reduceTimers } from './logic/timers';
import { makeWorkClock } from './logic/workhours';
import {
  DevStatusUnavailableError,
  fetchBoardMaps,
  fetchChangelog,
  fetchDoneStatusIds,
  fetchPullRequests,
  pageBoardIssues,
  sleep,
  type BoardMaps,
  type IssueHistory,
  type RawIssue,
  type RiskJiraClient,
} from './jira';
import { processBoardAlerts } from './alerts';
import { noticeDegradation } from './notify';
import {
  getState,
  listConfigs,
  markDegraded,
  overwriteSnapshot,
  recordFailure,
  recordSuccess,
  setDevStatusAvailable,
  type RiskBoardState,
  type RiskOrgConfig,
} from './store';

/** A board viewed this recently counts as actively watched. */
export const ACTIVE_VIEW_WINDOW_MS = 30 * 60_000;
/** Cadence for actively-watched boards. */
export const ACTIVE_REFRESH_MS = 5 * 60_000;
/** Cadence for everything else. */
export const IDLE_REFRESH_MS = 60 * 60_000;
/** Deterministic per-board spread on the idle cadence, so hourly refreshes don't
 *  all land on the same tick. */
export const IDLE_JITTER_MS = 6 * 60_000;
/** Workers' per-invocation subrequest ceiling is ~1000; leave headroom for the
 *  other three cron jobs sharing the tick. */
export const TICK_SUBREQUEST_BUDGET = 600;
/** Pre-charge per board (board calls + ~30 issues x changelog). The actual call
 *  count is measured per board (a counting shim around the org's client), logged,
 *  and refunded/charged back against the tick budget as boards complete. */
export const BOARD_COST_ESTIMATE = 50;
/** Ceiling on the exponential failure backoff: a permanently broken board is retried
 *  at most this often, instead of burning budget on every 3-minute tick. */
export const BACKOFF_CAP_MS = 6 * 60 * 60_000;
/** Gap between Jira calls within one org. */
export const PACING_MS = 200;

/** Base issue fields every board refresh needs; custom fields are appended from
 *  the org's discovered/admin-picked ids (never hardcoded — repo invariant). */
const BASE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'assignee',
  'created',
  'parent',
  'issuelinks',
];

interface PlannedBoard {
  cloudId: string;
  board: RiskBoardRef;
  /** null (never refreshed) sorts oldest. */
  lastRefreshAt: string | null;
  /** Fallback ordering key for boards that have never succeeded. */
  lastAttemptAt: string | null;
}

/** What eligibility needs from a board's state row (a RiskBoardState satisfies it). */
export interface RiskEligibilityState {
  lastViewedAt: string | null;
  lastRefreshAt: string | null;
  lastAttemptAt?: string | null;
  failures?: number;
  degradedReason?: RiskDegradedReason | null;
}

// --- Eligibility + scheduling (pure, so the tests can drive them) -------------

/** Stable non-negative hash of (cloudId, boardId) — the jitter seed. */
function hashSeed(cloudId: string, boardId: number): number {
  let h = 2166136261;
  const s = `${cloudId}:${boardId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

/** Cadence only: is this board due, ignoring its failure history? */
function dueByCadence(
  cloudId: string,
  boardId: number,
  state: RiskEligibilityState | null,
  nowMs: number,
): boolean {
  const lastRefresh = state?.lastRefreshAt ? Date.parse(state.lastRefreshAt) : null;
  if (lastRefresh == null) return true; // never refreshed: the viewer is waiting
  const age = nowMs - lastRefresh;
  const viewedAt = state?.lastViewedAt ? Date.parse(state.lastViewedAt) : null;
  const active = viewedAt != null && nowMs - viewedAt <= ACTIVE_VIEW_WINDOW_MS;
  if (active) return age >= ACTIVE_REFRESH_MS;
  return age >= IDLE_REFRESH_MS + hashSeed(cloudId, boardId) * IDLE_JITTER_MS;
}

/**
 * Is this board due for a refresh this tick? Cadence first, then the two brakes
 * that keep a permanently-broken board from burning the budget forever (a board
 * that never succeeds never gets a `last_refresh_at`, so cadence alone would elect
 * it on every single tick and sort it to the head of the queue):
 *   - exponential backoff on consecutive failures, capped at BACKOFF_CAP_MS;
 *   - `needs_reauth` is only retried once the org's config has been touched
 *     (markDegraded deliberately doesn't count a failure, so backoff can't cover
 *     it) — OR once the refresher's grant looks usable again, which is the common
 *     real recovery and needs no human at all (`refresherUsable`).
 */
export function isEligible(
  cloudId: string,
  boardId: number,
  state: RiskEligibilityState | null,
  nowMs: number,
  cfgUpdatedAt: string | null = null,
  /** The org's refresher grant currently looks usable (token present, not flagged
   *  needs_reauth) — e.g. the refresher simply logged in again, which clears the
   *  flag in dao.upsertUser without anyone touching the risk config. */
  refresherUsable = false,
): boolean {
  if (!dueByCadence(cloudId, boardId, state, nowMs)) return false;

  const lastAttempt = state?.lastAttemptAt ? Date.parse(state.lastAttemptAt) : null;
  if (lastAttempt == null) return true;

  if (state?.degradedReason === 'needs_reauth' && !refresherUsable) {
    const configuredAt = cfgUpdatedAt ? Date.parse(cfgUpdatedAt) : null;
    if (configuredAt == null || configuredAt <= lastAttempt) return false;
    return true;
  }
  // A re-elected needs_reauth board falls THROUGH to the failure backoff rather
  // than short-circuiting, so a board whose grant is healthy but which keeps
  // failing for some other reason still backs off exponentially.

  const failures = state?.failures ?? 0;
  if (failures > 0) {
    const wait = Math.min(2 ** failures * ACTIVE_REFRESH_MS, BACKOFF_CAP_MS);
    if (nowMs - lastAttempt < wait) return false;
  }
  return true;
}

/**
 * Does this org's designated refresher currently look able to reach Jira? The
 * single most common real recovery from `needs_reauth` is the refresher simply
 * logging in again — `dao.upsertUser` clears the flag on every login, which the
 * risk board would otherwise never notice. Two queries, per degraded org only.
 */
export async function refresherUsable(dao: Dao, cfg: RiskOrgConfig): Promise<boolean> {
  const accountId = cfg.refresherAccountId;
  if (!accountId) return false;
  if (!(await dao.getToken(accountId))) return false;
  return !(await dao.getUserNeedsReauth(accountId));
}

/**
 * Staleness order (oldest first) with round-robin fairness across orgs: take one
 * board from each org in turn, so a 20-board org can't fill the budget ahead of a
 * 1-board org. A board that has never succeeded falls back to its last ATTEMPT, so
 * one that keeps failing doesn't permanently head the queue ahead of healthy but
 * stale boards.
 */
export function interleaveByOrg(planned: PlannedBoard[]): PlannedBoard[] {
  const staleness = (p: PlannedBoard): number =>
    p.lastRefreshAt
      ? Date.parse(p.lastRefreshAt)
      : p.lastAttemptAt
        ? Date.parse(p.lastAttemptAt)
        : -Infinity;
  const byOrg = new Map<string, PlannedBoard[]>();
  for (const p of [...planned].sort((a, b) => staleness(a) - staleness(b))) {
    const list = byOrg.get(p.cloudId);
    if (list) list.push(p);
    else byOrg.set(p.cloudId, [p]);
  }
  // Orgs in order of their stalest board; then one board per org per round.
  const queues = [...byOrg.values()].sort((a, b) => staleness(a[0]!) - staleness(b[0]!));
  const out: PlannedBoard[] = [];
  for (let round = 0; out.length < planned.length; round++) {
    for (const q of queues) {
      const item = q[round];
      if (item) out.push(item);
    }
  }
  return out;
}

// --- The cron entry point -----------------------------------------------------

export async function refreshRiskBoards(
  env: Env,
  dao: Dao,
  log: Logger = rootLog,
  nowMs: number = Date.now(),
  /** Gap between Jira calls; tests pass 0 to skip the pacing sleeps. */
  pacingMs: number = PACING_MS,
): Promise<void> {
  const configs = await listConfigs(env);
  if (configs.length === 0) return;

  const planned: PlannedBoard[] = [];
  const byCloud = new Map<string, RiskOrgConfig>();
  for (const cfg of configs) {
    byCloud.set(cfg.cloudId, cfg);
    const states: Array<RiskBoardState | null> = [];
    // Two extra queries, computed lazily — only for an org that actually has a
    // needs_reauth board, and only once for that org.
    let usable: boolean | null = null;
    for (const board of cfg.boards) {
      const state = await getState(env, cfg.cloudId, board.boardId);
      states.push(state);
      if (state?.degradedReason === 'needs_reauth' && usable === null) {
        usable = await refresherUsable(dao, cfg);
      }
      if (!isEligible(cfg.cloudId, board.boardId, state, nowMs, cfg.updatedAt, usable ?? false)) {
        continue;
      }
      planned.push({
        cloudId: cfg.cloudId,
        board,
        lastRefreshAt: state?.lastRefreshAt ?? null,
        lastAttemptAt: state?.lastAttemptAt ?? null,
      });
    }
    // Tell this org's admins when its boards stop (or resume) updating. Runs over
    // the CONFIG loop, above the early return below, because the orgs that most
    // need announcing — needs_reauth, or an erased refresher — are exactly the ones
    // that are never eligible, so nothing hung off refreshOrg would ever fire.
    // Recovery is therefore observed on the tick AFTER a successful refresh (state
    // is read at the top of the tick): a <= 3-minute lag, deliberately traded for
    // one code path. Isolated per org so a notification problem never stops the
    // refresh fleet.
    try {
      await noticeDegradation(env, dao, cfg, states, log, nowMs);
    } catch (e) {
      log.warn('risk: degraded-notice failed', { cloudId: cfg.cloudId, ...errFields(e) });
    }
  }
  if (planned.length === 0) return;

  // Fair selection first, then group back per org for execution. Each selected
  // board pre-charges an estimate; refreshOrg reconciles it against the actual
  // Jira-call count as boards complete and stops early if the tick overspends.
  const selected: PlannedBoard[] = [];
  const budget: TickBudget = { remaining: TICK_SUBREQUEST_BUDGET };
  for (const p of interleaveByOrg(planned)) {
    if (budget.remaining < BOARD_COST_ESTIMATE) break;
    budget.remaining -= BOARD_COST_ESTIMATE;
    selected.push(p);
  }
  const perOrg = new Map<string, RiskBoardRef[]>();
  for (const p of selected) {
    const list = perOrg.get(p.cloudId);
    if (list) list.push(p.board);
    else perOrg.set(p.cloudId, [p.board]);
  }

  let jiraCalls = 0;
  for (const [cloudId, boards] of perOrg) {
    const cfg = byCloud.get(cloudId);
    if (!cfg) continue;
    // One org's trouble never stops the fleet.
    try {
      jiraCalls += await refreshOrg(env, dao, cfg, boards, log, nowMs, pacingMs, budget);
    } catch (e) {
      log.error('risk: org refresh threw', { cloudId, ...errFields(e) });
    }
  }
  log.info('risk: refresh tick done', {
    orgs: perOrg.size,
    boards: selected.length,
    deferred: planned.length - selected.length,
    jiraCalls,
  });
}

/** The tick's remaining Jira-call allowance, shared across orgs (mutable cell). */
export interface TickBudget {
  remaining: number;
}

/**
 * One org's unit of work: resolve the admin-designated refresher's grant, then
 * refresh the given boards serially with paced Jira calls. Self-contained by
 * design — see the Queue graduation note at the top of this file.
 *
 * Returns the number of Jira calls it made (the graduation trigger for the Queue
 * deviation is measured, not guessed — see 1_changes-from-arch.md §2/§9).
 */
export async function refreshOrg(
  env: Env,
  dao: Dao,
  cfg: RiskOrgConfig,
  boards: RiskBoardRef[],
  log: Logger = rootLog,
  nowMs: number = Date.now(),
  pacingMs: number = PACING_MS,
  budget?: TickBudget,
): Promise<number> {
  const orgLog = log.child({ cloudId: cfg.cloudId });
  const atIso = new Date(nowMs).toISOString();
  const accountId = cfg.refresherAccountId;
  const token = accountId ? await dao.getToken(accountId) : null;
  if (!accountId || !token || (await dao.getUserNeedsReauth(accountId))) {
    // Retrying can't help until an admin re-designates or the refresher re-logs in.
    for (const b of boards) {
      await markDegraded(env, cfg.cloudId, b.boardId, 'needs_reauth', atIso);
    }
    orgLog.warn('risk: refresher grant unusable', { accountId, boards: boards.length });
    return 0;
  }
  const client = new JiraClient(env, dao, token, cfg.cloudId);
  // Count every Jira call this org makes: the estimate above is only an estimate,
  // and the per-org actuals are what tell us when the cron budget is outgrown.
  let jiraCalls = 0;
  const counted: RiskJiraClient = {
    get: <T>(path: string): Promise<T> => {
      jiraCalls++;
      return client.get<T>(path);
    },
  };
  const appConfig = await dao.getConfig(cfg.cloudId);
  if (appConfig.storyPointsFieldId == null) {
    orgLog.warn(
      'risk: no Story Points field resolved for this org — size-specific cutoffs will not apply',
    );
  }

  for (let i = 0; i < boards.length; i++) {
    const board = boards[i]!;
    if (budget && budget.remaining < 0) {
      orgLog.warn('risk: tick budget overspent; deferring the rest to the next tick', {
        jiraCalls,
        deferred: boards.length - i,
      });
      break;
    }
    const before = jiraCalls;
    try {
      const snapshot = await refreshBoard(env, counted, cfg, board, {
        storyPointsFieldId: appConfig.storyPointsFieldId,
        nowMs,
        pacingMs,
        dao,
        log: orgLog,
      });
      await recordSuccess(env, cfg.cloudId, board.boardId, atIso);
      orgLog.info('risk: board refreshed', {
        boardId: board.boardId,
        tickets: snapshot.tickets.length,
        jiraCalls: jiraCalls - before,
        ...snapshot.tierCounts,
      });
    } catch (e) {
      const rest = boards.slice(i);
      if (e instanceof ReauthRequiredError) {
        for (const b of rest) {
          await markDegraded(env, cfg.cloudId, b.boardId, 'needs_reauth', atIso);
        }
        orgLog.warn('risk: refresher needs re-auth; skipping org for this tick', { jiraCalls });
        return jiraCalls;
      }
      if (e instanceof JiraApiError && e.status === 429) {
        // Rate-limited: back off for the WHOLE org, leave other orgs alone.
        for (const b of rest) await recordFailure(env, cfg.cloudId, b.boardId, atIso);
        orgLog.warn('risk: rate limited; skipping org for this tick', { jiraCalls });
        return jiraCalls;
      }
      await recordFailure(env, cfg.cloudId, board.boardId, atIso);
      orgLog.warn('risk: board refresh failed', {
        boardId: board.boardId,
        jiraCalls: jiraCalls - before,
        ...errFields(e),
      });
    }
    // Reconcile this board's pre-charge with what it actually cost. A board that
    // over-spends takes the overrun out of the rest of the tick.
    if (budget) budget.remaining += BOARD_COST_ESTIMATE - (jiraCalls - before);
  }
  orgLog.info('risk: org refresh done', { boards: boards.length, jiraCalls });
  return jiraCalls;
}

// --- One board ----------------------------------------------------------------

export interface RefreshBoardOptions {
  /** The org's discovered Story Points field (dao config) — never a hardcoded id. */
  storyPointsFieldId: string | null;
  nowMs: number;
  /** Gap between Jira calls; tests pass 0. */
  pacingMs?: number;
  /** Required so the Phase-2 alert pass can resolve recipients' channels. Made
   *  required (not optional) so production can't silently skip alerting; the
   *  risk-internal call sites all already hold a Dao. */
  dao: Dao;
  /** Threaded so the alert pass logs under the same run context. */
  log?: Logger;
}

/**
 * Fetch a board, compute every ticket's metrics, and overwrite its snapshot.
 * Ports rbBuildBoard. Returns the snapshot it stored.
 */
export async function refreshBoard(
  env: Env,
  client: RiskJiraClient,
  cfg: RiskOrgConfig,
  board: RiskBoardRef,
  opts: RefreshBoardOptions,
): Promise<RiskBoardSnapshot> {
  const pacing = opts.pacingMs ?? PACING_MS;
  const pace = async (): Promise<void> => {
    if (pacing > 0) await sleep(pacing);
  };

  const schedule: RiskWorkSchedule = cfg.schedule ?? DEFAULT_SCHEDULE;
  const cutoffs = cfg.cutoffs ?? DEFAULT_CUTOFFS;
  const composite = cfg.composite ?? DEFAULT_COMPOSITE;
  const inProgressStatus = cfg.inProgressStatus ?? DEFAULT_IN_PROGRESS_STATUS;
  const clock = makeWorkClock(schedule);

  const maps = await fetchBoardMaps(client, board.boardId);
  await pace();
  const doneStatusIds = await fetchDoneStatusIds(client);
  await pace();

  const fields = [...BASE_FIELDS];
  for (const id of [opts.storyPointsFieldId, ...cfg.fields.map((e) => e.fieldId)]) {
    if (id && !fields.includes(id)) fields.push(id);
  }
  const issues = await pageBoardIssues(client, board.boardId, fields);
  await pace();

  // dev-status is probed once per org: null = try it, false = never call it again.
  let devStatus = cfg.devStatusAvailable;
  const tickets: RiskTicket[] = [];
  for (const issue of issues) {
    const history = await fetchChangelog(client, issue.id);
    await pace();
    let prs: RiskPrResult = undefined;
    if (devStatus !== false) {
      try {
        prs = await fetchPullRequests(client, issue.id);
        if (devStatus == null) {
          devStatus = true;
          // Mirror the probe verdict onto the in-memory config too, or every later
          // board in this org (same cfg object) would re-probe this tick.
          cfg.devStatusAvailable = true;
          await setDevStatusAvailable(env, cfg.cloudId, true);
        }
      } catch (e) {
        if (e instanceof DevStatusUnavailableError) {
          devStatus = false;
          cfg.devStatusAvailable = false;
          await setDevStatusAvailable(env, cfg.cloudId, false);
        } else {
          // Transient (429/5xx): let it fail the board rather than latching the
          // probe verdict on a blip — jira.ts re-throws those deliberately.
          throw e;
        }
      }
      await pace();
    }
    tickets.push(
      mapIssue(issue, {
        maps,
        doneStatusIds,
        history,
        prs,
        cutoffs,
        composite,
        inProgressStatus,
        storyPointsFieldId: opts.storyPointsFieldId,
        fields: cfg.fields,
        clock,
        nowMs: opts.nowMs,
      }),
    );
  }

  // Worst first: the list order IS the triage order (nulls — done tickets — last).
  tickets.sort((a, b) => (b.composite.score ?? -1) - (a.composite.score ?? -1));

  const snapshot: RiskBoardSnapshot = {
    boardId: board.boardId,
    boardName: board.name,
    columns: maps.columnNames,
    tickets,
    tierCounts: tierCounts(tickets.map((t) => t.tier)),
    cutoffs,
    composite,
    schedule,
    fields: cfg.fields,
    computedAt: new Date(opts.nowMs).toISOString(),
  };

  // PHASE 2 seam: diff vs risk_alert_state + fire health nudges (arch §9). Wrapped
  // so an alerting failure can never fail the board — the snapshot still overwrites
  // and the board still records success. State is written before the snapshot
  // (arch step ordering), so a nudge whose board view is one refresh stale is
  // harmless: alert state is already latched, so the re-run can't re-send.
  const alertLog = opts.log ?? rootLog;
  try {
    await processBoardAlerts(env, opts.dao, cfg, board, tickets, clock, alertLog, opts.nowMs);
  } catch (e) {
    alertLog.warn('risk: alert pass failed; snapshot proceeds', {
      boardId: board.boardId,
      ...errFields(e),
    });
  }

  await overwriteSnapshot(env, cfg.cloudId, snapshot);
  return snapshot;
}

// --- Issue mapping (ports rbMapIssue) ----------------------------------------

type RiskPrResult = RiskTicket['prs'];

interface MapContext {
  maps: BoardMaps;
  doneStatusIds: Set<string>;
  history: IssueHistory;
  prs: RiskPrResult;
  cutoffs: RiskBoardSnapshot['cutoffs'];
  composite: RiskBoardSnapshot['composite'];
  inProgressStatus: string;
  storyPointsFieldId: string | null;
  fields: RiskOrgConfig['fields'];
  clock: ReturnType<typeof makeWorkClock>;
  nowMs: number;
}

interface StatusField {
  id?: string | number;
  name?: string;
  statusCategory?: { key?: string };
}
interface UserField {
  accountId?: string;
  displayName?: string;
  avatarUrls?: Record<string, string>;
}
interface IssueLink {
  type?: { name?: string };
  inwardIssue?: { key?: string; fields?: { status?: StatusField } };
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

export function mapIssue(issue: RawIssue, ctx: MapContext): RiskTicket {
  const f = issue.fields;
  const st = (f['status'] ?? {}) as StatusField;
  const statusId = st.id != null ? String(st.id) : '';
  const statusName = st.name ?? '';
  const assigneeField = f['assignee'] as UserField | null | undefined;
  const assignee = assigneeField?.displayName ?? null;
  const avatarUrl = assigneeField?.avatarUrls?.['32x32'] ?? null;
  const created = (f['created'] as string | undefined) ?? new Date(ctx.nowMs).toISOString();
  const points = ctx.storyPointsFieldId ? num(f[ctx.storyPointsFieldId]) : null;
  const isDone = st.statusCategory?.key === 'done';
  const column = ctx.maps.statusToColumn[statusId] ?? statusName;

  // Blocked = an open inward Blocks link (blocker neither in a done category nor
  // in the board's done column). Link-only: an admin-mapped flag field (e.g.
  // Flagged) is its own labeled metric in fieldMetrics, never OR'd in here.
  const blockedByOpen: string[] = [];
  for (const l of (f['issuelinks'] as IssueLink[] | undefined) ?? []) {
    if (!l.inwardIssue || l.type?.name !== 'Blocks') continue;
    const bs = l.inwardIssue.fields?.status;
    const bStatusId = bs?.id != null ? String(bs.id) : null;
    const inDoneCol = bStatusId != null && ctx.maps.doneColumnStatusIds.has(bStatusId);
    const catDone = bs?.statusCategory?.key === 'done';
    if (!inDoneCol && !catDone && l.inwardIssue.key) blockedByOpen.push(l.inwardIssue.key);
  }
  const blocked = blockedByOpen.length > 0;

  const boardMaps = {
    statusToColumn: ctx.maps.statusToColumn,
    doneStatusIds: ctx.doneStatusIds,
    doneColumnStatusIds: ctx.maps.doneColumnStatusIds,
  };
  const timers = reduceTimers(
    {
      ...boardMaps,
      created,
      statusChanges: ctx.history.status,
      assigneeChangeAts: ctx.history.assignee.map((a) => a.at),
      currentStatusId: statusId,
      currentStatusName: statusName,
      inProgressStatus: ctx.inProgressStatus,
      nowMs: ctx.nowMs,
    },
    ctx.clock.workMs,
  );
  const seg = buildSegments(
    {
      ...boardMaps,
      created,
      statusChanges: ctx.history.status,
      assigneeChanges: ctx.history.assignee,
      currentStatusId: statusId,
      currentStatusName: statusName,
      currentAssignee: assignee,
      inProgressStatus: ctx.inProgressStatus,
      nowMs: ctx.nowMs,
    },
    ctx.clock.workMs,
    ctx.clock.workMsWithin,
  );

  // Raw value per configured field — the key is ALWAYS present for every
  // configured entry (an issue without the field reads null), which is what
  // separates "no value" from "not measured" (absent key) downstream.
  const fieldValues: Record<string, number | boolean | null> = {};
  for (const entry of ctx.fields) {
    fieldValues[entry.fieldId] =
      entry.kind === 'count' ? num(f[entry.fieldId]) : !!f[entry.fieldId];
  }

  const health = evaluateTicket(
    {
      column,
      points,
      blocked,
      started: timers.started,
      idleHours: timers.idleHours,
      timeInColumnHours: timers.timeInColumnHours,
      cycleHours: timers.cycleHours,
      fieldValues,
    },
    ctx.cutoffs,
    ctx.composite,
    ctx.maps.columnNames,
    ctx.fields,
  );

  const issueType = f['issuetype'] as { name?: string } | undefined;
  const parent = f['parent'] as { key?: string } | undefined;

  return {
    key: issue.key,
    summary: (f['summary'] as string | undefined) ?? '',
    type: issueType?.name ?? '',
    status: statusName,
    column,
    assignee,
    avatarUrl,
    assigneeAccountId: assigneeField?.accountId ?? null,
    points,
    parentKey: parent?.key ?? null,
    blocked,
    blockedByOpen,
    unassignedInProgress: assignee == null && column !== ctx.maps.firstCol && !isDone,
    done: isDone,
    started: timers.started,
    idleHours: timers.idleHours,
    timeInColumnHours: timers.timeInColumnHours,
    cycleHours: timers.cycleHours,
    fieldValues,
    fieldMetrics: health.fieldMetrics,
    metrics: health.metrics,
    composite: health.composite,
    tier: health.tier,
    columnTotals: seg.columnTotals,
    flow: seg.flow,
    recentUpdaters: recentUpdaters(ctx.history.events, ctx.nowMs),
    ...(ctx.prs !== undefined ? { prs: ctx.prs } : {}),
  };
}
