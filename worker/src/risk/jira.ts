// Risk-board Jira reads. A thin layer over the app's JiraClient.get<T>() — this
// module owns only the board-specific endpoints the userscript used
// (rbFetchBoardMaps / rbFetchDoneStatusIds / rbPageAgile / rbFetchHistory /
// rbFetchPullRequests) and never touches auth, tokens or the poller's search code.
//
// Everything is typed against a STRUCTURAL client (`{ get<T>(path) }`) so the
// refresh tests can hand it canned JSON without minting an OAuth grant.
//
// Custom-field ids are never hardcoded here (repo invariant): the caller passes
// the ids discovered by the app (Story Points) or picked by an admin (the
// generic field-mapping entries).

import { JiraApiError } from '../jira/client';
import type { RiskFieldMeta, RiskPr, RiskStatusCategory, RiskStatusOption } from '@shared/risk';
import { kindForSchemaType } from '@shared/risk-fields';
import type { AssigneeChange, ChangelogEvent, StatusChange } from './logic/timers';

/** The only capability the risk board needs from a Jira client. */
export interface RiskJiraClient {
  get<T>(path: string): Promise<T>;
}

export interface RawIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

export interface BoardMaps {
  columnNames: string[];
  statusToColumn: Record<string, string>;
  firstCol: string | null;
  /** Status ids in the board's LAST column — the board's own "Done" (by position). */
  doneColumnStatusIds: Set<string>;
}

export interface IssueHistory {
  status: StatusChange[];
  assignee: AssigneeChange[];
  events: ChangelogEvent[];
}

/** Pacing between Jira calls inside one org (per-tenant rate limits are per-org). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function id(v: unknown): string | null {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
}

// --- Board configuration (PROBE #1) ------------------------------------------

interface BoardConfigResponse {
  columnConfig?: { columns?: { name?: string; statuses?: { id?: string | number }[] }[] };
}

/**
 * The board's column layout. "Done" is the LAST column by position — not Jira's
 * status category (a column named Done may hold statuses Jira hasn't marked done
 * but which are finished on THIS board).
 *
 * PROBE #1: board CONFIGURATION is the one Agile read that needs the *admin*
 * board scope — `read:board-scope.admin:jira-software` (a DIFFERENT scope from
 * `read:board-scope:jira-software`, not a superset) plus `read:project:jira`.
 * A 401/403 here means either the token was consented without them (an expensive
 * fix — scopes freeze at consent) or the account lacks project-admin rights on
 * the board (the scope is necessary, not sufficient). The error says both, and
 * the admin route runs this before anything is saved.
 */
export async function fetchBoardMaps(
  client: RiskJiraClient,
  boardId: number,
): Promise<BoardMaps> {
  let conf: BoardConfigResponse;
  try {
    conf = await client.get<BoardConfigResponse>(
      `/rest/agile/1.0/board/${boardId}/configuration`,
    );
  } catch (e) {
    if (e instanceof JiraApiError && (e.status === 401 || e.status === 403)) {
      throw new Error(
        `board ${boardId} configuration is not readable with this token (${e.status}) — ` +
          `the Agile board-configuration endpoint needs the granular scopes ` +
          `read:board-scope.admin:jira-software AND read:project:jira ` +
          `(the .admin scope is separate from read:board-scope:jira-software, not implied by it). ` +
          `Enable both on the app in the Atlassian developer console — listing them in ` +
          `OAUTH_SCOPES is not enough — then re-authorize, since scopes freeze at consent. ` +
          `The scope is necessary but not sufficient: Jira permissions still apply, so the ` +
          `designated refresher account also needs project-admin rights on this board.`,
      );
    }
    throw e;
  }
  const cols = conf.columnConfig?.columns ?? [];
  const columnNames = cols.map((c) => c.name ?? '');
  const statusToColumn: Record<string, string> = {};
  for (const c of cols) {
    for (const s of c.statuses ?? []) {
      const sid = id(s.id);
      if (sid) statusToColumn[sid] = c.name ?? '';
    }
  }
  const doneColName = columnNames.length ? columnNames[columnNames.length - 1] : null;
  const doneColumnStatusIds = new Set<string>();
  for (const c of cols) {
    if ((c.name ?? '') !== doneColName) continue;
    for (const s of c.statuses ?? []) {
      const sid = id(s.id);
      if (sid) doneColumnStatusIds.add(sid);
    }
  }
  return { columnNames, statusToColumn, firstCol: columnNames[0] ?? null, doneColumnStatusIds };
}

/** Every status Jira itself categorizes as done (the cycle clock skips these). */
export async function fetchDoneStatusIds(client: RiskJiraClient): Promise<Set<string>> {
  const arr = await client.get<{ id?: string | number; statusCategory?: { key?: string } }[]>(
    '/rest/api/3/status',
  );
  const out = new Set<string>();
  for (const st of arr ?? []) {
    const sid = id(st.id);
    if (sid && st.statusCategory?.key === 'done') out.add(sid);
  }
  return out;
}

/**
 * The site's status vocabulary, for the admin's In Progress status picker.
 *
 * Deduped BY NAME (Jira lists a status once per project that uses it) because the
 * config stores a name and `logic/timers.ts` matches on the name. `indeterminate`
 * first, then `new`, then `done`/`unknown` — the picker groups on `category`, so
 * the ordering here is what the groups end up in.
 */
export async function listStatusCandidates(
  client: RiskJiraClient,
): Promise<RiskStatusOption[]> {
  const arr = await client.get<{ name?: string; statusCategory?: { key?: string } }[]>(
    '/rest/api/3/status',
  );
  const byName = new Map<string, RiskStatusCategory>();
  for (const st of arr ?? []) {
    const name = typeof st.name === 'string' ? st.name.trim() : '';
    if (!name || byName.has(name)) continue;
    byName.set(name, statusCategory(st.statusCategory?.key));
  }
  const rank: Record<RiskStatusCategory, number> = {
    indeterminate: 0,
    new: 1,
    done: 2,
    unknown: 3,
  };
  return [...byName]
    .map(([name, category]) => ({ name, category }))
    .sort((a, b) => rank[a.category] - rank[b.category] || a.name.localeCompare(b.name));
}

function statusCategory(key: string | undefined): RiskStatusCategory {
  return key === 'new' || key === 'indeterminate' || key === 'done' ? key : 'unknown';
}

// --- Issues -------------------------------------------------------------------

interface AgileIssuePage {
  issues?: RawIssue[];
  total?: number;
}

const PAGE_SIZE = 50;

async function pageAgile(
  client: RiskJiraClient,
  path: string,
  fields: string[],
): Promise<RawIssue[]> {
  const out: RawIssue[] = [];
  let startAt = 0;
  let total = 1;
  while (startAt < total) {
    const sep = path.includes('?') ? '&' : '?';
    const q =
      `fields=${encodeURIComponent(fields.join(','))}` +
      `&startAt=${startAt}&maxResults=${PAGE_SIZE}`;
    const res = await client.get<AgileIssuePage>(`/rest/agile/1.0${path}${sep}${q}`);
    const issues = res.issues ?? [];
    out.push(...issues);
    total = typeof res.total === 'number' ? res.total : out.length;
    startAt += PAGE_SIZE;
    if (issues.length === 0) break;
  }
  return out;
}

/**
 * The issues a board is currently showing: a scrum board's ACTIVE sprints, or a
 * kanban board's whole backlog view. Ports rbPageAgile + the board/sprint walk of
 * rbBuildBoard.
 *
 * Scopes (see env.ts): `/board/{id}` and `/board/{id}/issue` need
 * `read:board-scope:jira-software` + `read:issue-details:jira`;
 * `/board/{id}/sprint/{sid}/issue` needs `read:sprint:jira-software` +
 * `read:issue-details:jira` + `read:jql:jira`. Deliberately NOT rewritten onto
 * JQL search — that fallback would cost board-column fidelity, which the whole
 * feature is built on.
 */
export async function pageBoardIssues(
  client: RiskJiraClient,
  boardId: number,
  fields: string[],
): Promise<RawIssue[]> {
  const board = await client.get<{ type?: string; name?: string }>(
    `/rest/agile/1.0/board/${boardId}`,
  );
  if (board.type !== 'scrum') return pageAgile(client, `/board/${boardId}/issue`, fields);
  const sprints = await client.get<{ values?: { id: number }[] }>(
    `/rest/agile/1.0/board/${boardId}/sprint?state=active`,
  );
  const out: RawIssue[] = [];
  for (const sp of sprints.values ?? []) {
    out.push(...(await pageAgile(client, `/board/${boardId}/sprint/${sp.id}/issue`, fields)));
  }
  return out;
}

// --- Changelog (PROBE #3) -----------------------------------------------------

interface ChangelogPage {
  values?: {
    created?: string;
    author?: { displayName?: string; name?: string };
    items?: Record<string, unknown>[];
  }[];
  total?: number;
}

/**
 * One issue's status + assignee history, plus a flat "who edited, when" event
 * list. Ports rbFetchHistory. PROBE #3 — a PLATFORM endpoint (`/rest/api/3/...`),
 * so unlike the Agile reads above it is covered by the classic `read:jira-work`
 * scope this app already requests (probed 200 on a live site).
 */
export async function fetchChangelog(
  client: RiskJiraClient,
  issueId: string,
): Promise<IssueHistory> {
  const status: StatusChange[] = [];
  const assignee: AssigneeChange[] = [];
  const events: ChangelogEvent[] = [];
  let startAt = 0;
  let total = 1;
  while (startAt < total) {
    const res = await client.get<ChangelogPage>(
      `/rest/api/3/issue/${issueId}/changelog?startAt=${startAt}&maxResults=100`,
    );
    const values = res.values ?? [];
    for (const h of values) {
      const created = h.created;
      // One changelog entry = one edit by one author at one time (it may touch
      // several fields). Record it once for "who updated this, and when".
      const author = h.author?.displayName ?? h.author?.name ?? null;
      if (author && created) events.push({ at: created, author });
      for (const item of h.items ?? []) {
        if (!created) continue;
        if (item['field'] === 'status') {
          status.push({
            at: created,
            fromId: id(item['from']) ?? '',
            fromName: str(item['fromString']),
            toId: id(item['to']) ?? '',
            toName: str(item['toString']),
          });
        } else if (item['field'] === 'assignee') {
          assignee.push({
            at: created,
            from: str(item['fromString']),
            to: str(item['toString']),
          });
        }
      }
    }
    total = typeof res.total === 'number' ? res.total : status.length + assignee.length;
    startAt += 100;
    if (values.length === 0) break;
  }
  return { status, assignee, events };
}

// --- Pull requests (PROBE #2, probe-gated) -----------------------------------

interface DevStatusSummary {
  summary?: { pullrequest?: { byInstanceType?: Record<string, unknown> } };
}
interface DevStatusDetail {
  detail?: {
    _instance?: { name?: string };
    pullRequests?: Record<string, unknown>[];
  }[];
}

function normalizePr(pr: Record<string, unknown>, instanceName: string | null): RiskPr {
  const rawStatus = String(pr['status'] ?? '').toUpperCase();
  const state: RiskPr['state'] =
    rawStatus === 'MERGED'
      ? 'merged'
      : rawStatus === 'DECLINED' || rawStatus === 'ABANDONED'
        ? 'declined'
        : 'active'; // OPEN and anything unrecognized shows as active
  const reviewers = Array.isArray(pr['reviewers'])
    ? (pr['reviewers'] as Record<string, unknown>[])
    : [];
  const source = pr['source'] as Record<string, unknown> | undefined;
  const destination = pr['destination'] as Record<string, unknown> | undefined;
  const repository = pr['repository'] as Record<string, unknown> | undefined;
  const author = pr['author'] as Record<string, unknown> | undefined;
  return {
    id: String(pr['id'] ?? '').replace(/^#/, ''),
    title: str(pr['name']) ?? '',
    url: str(pr['url']) ?? '',
    state,
    repo: str(pr['repositoryName']) ?? str(repository?.['name']) ?? instanceName ?? '',
    author: str(author?.['name']) ?? '',
    updated: str(pr['lastUpdate']) ?? str(pr['lastUpdated']),
    source: str(source?.['branch']) ?? str(source?.['name']),
    target: str(destination?.['branch']) ?? str(destination?.['name']),
    approvals: reviewers.filter(
      (r) => r['approved'] === true || String(r['approvalStatus']).toUpperCase() === 'APPROVED',
    ).length,
    reviewers: reviewers.length,
  };
}

/** Thrown when the dev-status endpoint itself is unavailable, so the caller can
 *  persist `dev_status_available = 0` and never call it again for that org. */
/** Transient Jira failures the caller must see (429 back-off, 5xx retry next tick)
 *  rather than have quietly turned into "this issue has no PRs". */
function isRetryable(e: unknown): boolean {
  return e instanceof JiraApiError && (e.status === 429 || e.status >= 500);
}

export class DevStatusUnavailableError extends Error {
  constructor(public readonly status: number) {
    super(`dev-status unavailable (${status})`);
    this.name = 'DevStatusUnavailableError';
  }
}

/**
 * PRs linked to an issue, from Jira's undocumented dev-status API (the source the
 * issue's Development panel renders from). Ports rbFetchPullRequests/rbNormalizePR.
 *
 * PROBE #2: this endpoint is very likely absent via api.atlassian.com OAuth. A
 * 401/403/404 raises DevStatusUnavailableError so the refresher can turn the
 * feature off for that org permanently — the userscript's own graceful-drop
 * contract, kept: we omit `prs` rather than faking it.
 *
 * A 429 or 5xx is RE-THROWN: those are transient, and the caller's per-org 429
 * handling (back off the whole org for this tick) must see them. Swallowing them
 * would both hammer a rate-limited org and latch `dev_status_available = 1` off a
 * blip. Anything else returns an empty list so one bad issue can't fail a board.
 */
export async function fetchPullRequests(
  client: RiskJiraClient,
  issueId: string,
): Promise<RiskPr[]> {
  let types: string[];
  try {
    const sum = await client.get<DevStatusSummary>(
      `/rest/dev-status/latest/issue/summary?issueId=${encodeURIComponent(issueId)}`,
    );
    const byInstanceType = sum.summary?.pullrequest?.byInstanceType;
    types = byInstanceType ? Object.keys(byInstanceType) : [];
  } catch (e) {
    if (e instanceof JiraApiError && [401, 403, 404].includes(e.status)) {
      throw new DevStatusUnavailableError(e.status);
    }
    if (isRetryable(e)) throw e;
    return [];
  }
  if (types.length === 0) return []; // no PRs linked to this issue

  const out: RiskPr[] = [];
  try {
    for (const t of types) {
      const q =
        `?issueId=${encodeURIComponent(issueId)}` +
        `&applicationType=${encodeURIComponent(t)}&dataType=pullrequest`;
      const res = await client.get<DevStatusDetail>(`/rest/dev-status/latest/issue/detail${q}`);
      for (const d of res.detail ?? []) {
        for (const pr of d.pullRequests ?? []) out.push(normalizePr(pr, d._instance?.name ?? null));
      }
    }
  } catch (e) {
    if (isRetryable(e)) throw e;
    return []; // reachable-but-failed: the board still renders
  }
  // Dedupe (a PR can appear under more than one instance); prefer url, else id.
  const seen = new Set<string>();
  const uniq: RiskPr[] = [];
  for (const pr of out) {
    const k = pr.url || pr.id;
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    uniq.push(pr);
  }
  return uniq;
}

// --- Field discovery (admin field-mapping picker) ------------------------------

interface FieldMetaRaw {
  id?: string;
  name?: string;
  schema?: { type?: string };
}

/** ALL of the site's Jira fields for the admin's field-mapping picker, sorted by
 *  name — system fields included (`labels`/`priority` are legitimate flag
 *  signals); the client text-filters the list. Each carries the `kind` an entry
 *  picking it would get (`schema.type` via the shared rule, so the stored kind
 *  can't drift from what the picker showed). Risk-owned on purpose: jira/fields.ts
 *  is the app's Story-Points/Sprint discovery and stays untouched. Ids are always
 *  chosen by an admin from this list, never hardcoded. */
export async function listAllFields(client: RiskJiraClient): Promise<RiskFieldMeta[]> {
  const all = await client.get<FieldMetaRaw[]>('/rest/api/3/field');
  return (all ?? [])
    .filter(
      (f): f is FieldMetaRaw & { id: string; name: string } =>
        typeof f.id === 'string' && f.id.length > 0 && typeof f.name === 'string' && f.name.length > 0,
    )
    .map((f) => {
      const schemaType = typeof f.schema?.type === 'string' ? f.schema.type : null;
      return { id: f.id, name: f.name, schemaType, kind: kindForSchemaType(schemaType) };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
