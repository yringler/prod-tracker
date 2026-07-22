// Sprint Risk Board — WIRE TYPES ONLY (no logic). The board's pure logic lives in
// worker/src/risk/logic/*: the snapshot carries every computed value the client
// needs (values, bands, scores, and each ticket's OWN resolved warn/risk
// thresholds), so the client never recomputes and the logic has exactly one
// consumer. Only the shapes that cross the wire belong here — same split as
// notifications.ts.
//
// Deletable: `rm shared/src/risk.ts` + the re-export line in index.ts (see the
// risk-board plan's deletion story).

import type { ApiIssue } from './contracts';

/** Band a metric is currently in. `none` = not applicable (done / not started). */
export type RiskBand = 'ok' | 'warn' | 'risk' | 'none';

/** The five scored metrics, in the order the server evaluates them. */
export type RiskMetricId = 'rejections' | 'blocked' | 'idle' | 'timeInColumn' | 'cycle';

/** One cutoff rule. Matched most-specific-first (column+size beats column-only
 *  beats size-only beats the `default` rule), independent of table order. */
export interface RiskCutoffRule {
  column?: string;
  /** Fibonacci story-point bucket, or 'none' for unpointed tickets. */
  size?: number | 'none';
  warn?: number;
  risk?: number;
  default?: boolean;
}

/** Per-metric cutoff tables. Only the three time-based metrics are configurable;
 *  rejections/blocked use fixed constants (see logic/scoring.ts). */
export interface RiskCutoffs {
  idle: RiskCutoffRule[];
  cycle: RiskCutoffRule[];
  timeInColumn: RiskCutoffRule[];
}

/** One validation finding about a cutoff table, addressed to a specific rule so
 *  the editor can highlight it. Errors block the save (server-side); warnings are
 *  advisory. See `validateCutoffs` in `risk-cutoffs.ts`. */
export interface RiskConfigIssue extends ApiIssue {
  metric?: 'idle' | 'cycle' | 'timeInColumn';
  /** Index into that metric's rule array — or, for field-entry issues, into the
   *  `fields` entry array (see `risk-fields.ts`). */
  index?: number;
  field?: 'column' | 'size' | 'warn' | 'risk' | 'default' | 'label' | 'fieldId' | 'kind' | 'weight';
}

/** Composite = weighted power-mean of the per-metric scores. p=1 → weighted
 *  average; higher p lets the worst metric dominate. */
export interface RiskCompositeConfig {
  p: number;
  weights: Partial<Record<RiskMetricId, number>>;
}

export type RiskWeekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

/** The work-hours clock every metric is measured in. `[open, close]` are wall-clock
 *  hours in `timeZone`; null = a non-working day. */
export interface RiskWorkSchedule {
  timeZone: string;
  days: Record<RiskWeekday, [open: number, close: number] | null>;
}

/** One metric's computed state for one ticket. `warn`/`risk` are the thresholds
 *  THIS ticket resolved to (column + size sensitive) — present only for the
 *  metrics that have them, so the detail view needs no client-side math. */
export interface RiskMetricState {
  value: number | boolean | null;
  band: RiskBand;
  /** value / risk-threshold (1.0 = at the risk line); null = no data. */
  score: number | null;
  warn?: number;
  risk?: number;
}

/** A column visit in the flow timeline. Done visits are kept as zero-cycle stubs. */
export interface RiskColumnSeg {
  column: string;
  status: string;
  fromMs: number;
  toMs: number;
  /** True if this visit was in a done status/column (a pause, not counted). */
  doneCat: boolean;
  hours: number;
}

export interface RiskAssigneeSeg {
  assignee: string | null;
  fromMs: number;
  toMs: number;
  hours: number;
}

export interface RiskFlow {
  createdAt: string;
  startedAt: string | null;
  columnSegs: RiskColumnSeg[];
  assigneeSegs: RiskAssigneeSeg[];
  totalHours: number;
}

/** A pull request linked to the issue via Jira's dev-status data. Present only
 *  when the per-org dev-status probe succeeded. */
export interface RiskPr {
  id: string;
  title: string;
  url: string;
  state: 'merged' | 'declined' | 'active';
  repo: string;
  author: string;
  updated: string | null;
  source: string | null;
  target: string | null;
  approvals: number;
  reviewers: number;
}

export interface RiskTicket {
  key: string;
  summary: string;
  type: string;
  status: string;
  column: string;
  assignee: string | null;
  avatarUrl: string | null;
  /** Atlassian account id — the recipient key for health nudges; org-visible in
   *  Jira already, so no new privacy surface. Null when unassigned (or on a
   *  snapshot written before this field shipped). */
  assigneeAccountId: string | null;
  points: number | null;
  parentKey: string | null;
  implementor: string | null;
  codeReviewer: string | null;
  rejections: number | null;
  blocked: boolean;
  blockedByOpen: string[];
  unassignedInProgress: boolean;
  done: boolean;
  started: boolean;
  idleHours: number | null;
  timeInColumnHours: number | null;
  cycleHours: number | null;
  metrics: Record<RiskMetricId, RiskMetricState>;
  composite: { score: number | null; band: RiskBand };
  /** Worst firing band across the metrics + composite; null = nothing firing
   *  (done column, or every metric still pending). */
  tier: RiskBand | null;
  columnTotals: { column: string; hours: number; visits: number }[];
  flow: RiskFlow;
  recentUpdaters: string[];
  prs?: RiskPr[];
}

/** Tickets by tier. Only tickets with a non-null tier are counted. */
export interface RiskTierCounts {
  risk: number;
  warn: number;
  ok: number;
}

/** One board's stored snapshot: computed by the cron write path, served verbatim
 *  by the read route. The effective config is echoed so the detail view can show
 *  the thresholds that were in force. */
export interface RiskBoardSnapshot {
  boardId: number;
  boardName: string;
  columns: string[];
  /** Sorted by composite score, worst first. */
  tickets: RiskTicket[];
  tierCounts: RiskTierCounts;
  cutoffs: RiskCutoffs;
  composite: RiskCompositeConfig;
  schedule: RiskWorkSchedule;
  computedAt: string;
}

/** Why a board's refresh is degraded. NULL/absent = healthy. */
export type RiskDegradedReason = 'needs_reauth' | 'errors';

// ---- Wire shapes (client <-> worker /api/risk/*) ----

export interface RiskBoardRef {
  boardId: number;
  name: string;
}

export interface RiskBoardSummary extends RiskBoardRef {
  computedAt: string | null;
  degradedReason: RiskDegradedReason | null;
  tierCounts: RiskTierCounts | null;
}

export interface RiskBoardsResponse {
  boards: RiskBoardSummary[];
}

export interface RiskBoardResponse {
  snapshot: RiskBoardSnapshot | null;
  computedAt: string | null;
  degradedReason: RiskDegradedReason | null;
  /** True when no snapshot exists yet — the cron will produce one shortly. */
  refreshing: boolean;
}

/** How a configured Jira field is scored. Resolved from Jira's `schema.type` at
 *  pick time (`number` → `count`, anything else → `flag`) and STORED on the entry,
 *  so behavior stays stable even if field discovery later changes its mind. */
export type RiskFieldKind = 'count' | 'flag';

/** One admin-configured Jira field, scored as its own composite metric under the
 *  admin's label. Field ids are discovered/admin-picked — never hardcoded (repo
 *  invariant). Validated by `validateFieldEntries` in `risk-fields.ts`. */
export interface RiskFieldConfigEntry {
  /** Admin-given display label; non-empty, unique across entries. */
  label: string;
  /** Jira field id (e.g. `customfield_1002`, `labels`); unique across entries. */
  fieldId: string;
  kind: RiskFieldKind;
  /** count kind only — required there, with 0 < warn < risk. Flag entries omit both. */
  warn?: number;
  risk?: number;
  /** Composite weight; absent = 1, 0 = excluded from the composite. */
  weight?: number;
}

/** One of the site's Jira fields, as offered by the admin field picker. */
export interface RiskFieldMeta {
  id: string;
  name: string;
  /** Jira's `schema.type`; null when Jira reports none. */
  schemaType: string | null;
  /** The kind an entry picking this field would get (derived from `schemaType`). */
  kind: RiskFieldKind;
}

/** Optional per-org custom-field ids. All discovered/admin-picked — never
 *  hardcoded (repo invariant). Absent/null = that feature degrades quietly. */
export interface RiskFieldIds {
  flagged?: string | null;
  rejections?: string | null;
  implementor?: string | null;
  codeReviewer?: string | null;
}

export interface RiskAdminConfig {
  boards: RiskBoardRef[];
  /** null = the code defaults (echoed separately as `defaults`). */
  cutoffs: RiskCutoffs | null;
  composite: RiskCompositeConfig | null;
  schedule: RiskWorkSchedule | null;
  fields: RiskFieldIds;
  inProgressStatus: string | null;
  refresherAccountId: string | null;
  /** null = unprobed; false = the dev-status endpoint isn't available (no PRs). */
  devStatusAvailable: boolean | null;
  configuredBy: string | null;
  updatedAt: string | null;
}

export interface RiskAdminConfigResponse {
  config: RiskAdminConfig;
  defaults: {
    cutoffs: RiskCutoffs;
    composite: RiskCompositeConfig;
    schedule: RiskWorkSchedule;
    inProgressStatus: string;
  };
}

export interface PutRiskConfigRequest {
  boards: RiskBoardRef[];
  cutoffs?: RiskCutoffs | null;
  composite?: RiskCompositeConfig | null;
  schedule?: RiskWorkSchedule | null;
  fields?: RiskFieldIds | null;
  inProgressStatus?: string | null;
  refresherAccountId?: string | null;
}

/** Live board candidates for the admin picker, with the board-configuration
 *  probe's verdict for the currently-selected boards. */
export interface RiskBoardCandidate extends RiskBoardRef {
  type: string | null;
}
export interface RiskBoardCandidatesResponse {
  boards: RiskBoardCandidate[];
  /** Non-null when the board-configuration probe failed (usually OAuth scopes). */
  probeError: string | null;
}

/** One configured board's column vocabulary, for the cutoffs editor's Scope picker
 *  and its per-board "that column isn't on every board" warning.
 *  `source` says where it came from: the STORED snapshot (zero Jira calls — the
 *  read-path invariant), a live board-configuration probe with the admin's token
 *  (for a board configured but never refreshed), or nothing at all. */
export interface RiskBoardColumns extends RiskBoardRef {
  columns: string[];
  /** The board's LAST column — treated as Done, and never scored. */
  doneColumn: string | null;
  source: 'snapshot' | 'live' | 'unavailable';
}

export interface RiskColumnsResponse {
  boards: RiskBoardColumns[];
  /** False = no Story Points field is resolved for this site, so every ticket
   *  buckets as 'none' and size-specific cutoff rules can never fire. */
  pointsFieldConfigured: boolean;
  /** Non-null when the live fallback probe failed (usually OAuth scopes). */
  probeError: string | null;
}

// ---- Impact preview (POST /api/admin/risk/preview) ----
//
// "With these thresholds: 12 risk / 9 warn / 40 ok (was 6 / 8 / 47)". The server
// re-runs the SCORER over each board's STORED snapshot tickets — zero Jira calls,
// and no drift, because it is the same `evaluateTicket` the cron writes with.

/** Candidate config to score against. `null` on a field means "inherit the shipped
 *  default" — the same semantics `PUT /api/admin/risk/config` stores as NULL. */
export interface RiskPreviewRequest {
  cutoffs: RiskCutoffs | null;
  composite: RiskCompositeConfig | null;
  /** Only used to detect staleness (see `scheduleStale`) — the preview cannot
   *  re-measure the clocks. */
  schedule?: RiskWorkSchedule | null;
}

/** A ticket whose tier changes under the candidate config. */
export interface RiskPreviewMover {
  key: string;
  summary: string;
  from: RiskBand | null;
  to: RiskBand | null;
}

export interface RiskPreviewBoard extends RiskBoardRef {
  /** `no-snapshot` = configured but never refreshed. Nothing to preview; reported
   *  rather than errored, and left OUT of the totals. */
  status: 'previewed' | 'no-snapshot';
  /** Tiers the stored snapshot actually shows on /risk right now. */
  before: RiskTierCounts;
  /** Tiers the same tickets would land in under the candidate config. */
  after: RiskTierCounts;
  /** Tickets entering the `risk` tier / entering `ok` — the "worse" and "better"
   *  halves of the move, so a worsening board can be told from an improving one. */
  movedToRisk: number;
  movedToOk: number;
  /** Every ticket whose tier changed at all (>= movedToRisk + movedToOk). */
  moved: number;
  /** Up to `sampleLimit` movers, worst move first. */
  sampleMovers: RiskPreviewMover[];
  /** True when `moved > sampleMovers.length` — the cap is never silent. */
  sampleTruncated: boolean;
  computedAt: string | null;
  /** The stored clock values were measured under a DIFFERENT work schedule than
   *  the candidate one, so idle/in-column/cycle will shift at the next refresh
   *  in a way this preview cannot show. */
  scheduleStale: boolean;
}

export interface RiskPreviewTotals {
  before: RiskTierCounts;
  after: RiskTierCounts;
  movedToRisk: number;
  movedToOk: number;
  moved: number;
}

export interface RiskPreviewResponse {
  boards: RiskPreviewBoard[];
  /** Summed over the `previewed` boards only. */
  totals: RiskPreviewTotals;
  /** Configured boards with no snapshot yet, excluded from `totals`. */
  boardsWithoutSnapshot: number;
  /** True if any previewed board is schedule-stale. */
  scheduleStale: boolean;
  /** The per-board cap applied to `sampleMovers`. */
  sampleLimit: number;
}

/** Per-user opt-out for struggling-ticket health nudges (Phase 2). Self-scoped:
 *  the route always reads/writes the caller's own account. */
export interface RiskAlertPrefs {
  muted: boolean;
}
export interface PutRiskAlertPrefsRequest {
  muted: boolean;
}

export interface RiskFieldOption {
  id: string;
  name: string;
}
/** Jira's own `statusCategory.key`, plus `unknown` for a status Jira reports
 *  without one. `indeterminate` is what Jira means by "in progress", so it is the
 *  group the In Progress picker offers first. */
export type RiskStatusCategory = 'new' | 'indeterminate' | 'done' | 'unknown';

/** A candidate for `inProgressStatus`. Deduped BY NAME, because the config stores
 *  a name and the timers match on the name (`logic/timers.ts`) — the same status
 *  name repeated across projects is one choice here, not several. */
export interface RiskStatusOption {
  name: string;
  category: RiskStatusCategory;
}

export interface RiskFieldCandidatesResponse {
  flagged: RiskFieldOption[];
  rejections: RiskFieldOption[];
  implementor: RiskFieldOption[];
  codeReviewer: RiskFieldOption[];
  /** The site's status vocabulary, for the In Progress status picker. Empty when
   *  the status read failed — the picker then still offers the stored value. */
  statuses: RiskStatusOption[];
  current: RiskFieldIds;
}
