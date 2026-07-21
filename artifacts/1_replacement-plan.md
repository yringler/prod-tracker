# Sprint Risk Board — Replacement Implementation Plan (grounded in this repo)

> **Status of this document.** This replaces the implementation topology of
> `0_arch.md` for the storypoint-tracker repo as it actually exists. It keeps the
> arch doc's product design (§9–§11), domain rules (§10), and top constraint
> ("easy to delete", §2), but re-grounds the infrastructure in the real codebase:
> one Cloudflare Worker, D1 only, a 3-minute cron, per-user OAuth tokens.
> Every deviation from `0_arch.md` is recorded in `1_changes-from-arch.md` —
> read that alongside this. Line references into `0_userscript.js` are to the
> copy in this folder.

**Scale target (confirmed):** one org today, must scale to **a few dozen orgs**
without redesign. Not the arch doc's 1,000-tenant fleet. Everything below is
sized for that: the data model is org-keyed (`cloud_id`) everywhere, and the one
component built scale-ready from day one is the cron refresh scheduler.

---

## 0. Decisions & rationale

| Decision | Choice | Rationale |
|---|---|---|
| Topology | **Inside the existing Worker** — own directory `worker/src/risk/`, own `risk_*` tables, a 4th isolated cron job, own routes file, lazy Angular route | Repo is a single deploy; a few dozen orgs fits comfortably in cron capacity (see §3); deletion = rm directories + ~10 registration lines + drop tables |
| Token custody | **Admin-designated per-org refresher account** (`refresher_account_id`), using the existing `oauth_tokens` row for that account | Repo has per-user rotating tokens, no tenant-grant concept; mirrors the per-org admin-entered Zulip config pattern (`zulip_org_config`) |
| Notifications (arch §9) | **Phase 2** — schema sketched, seam marked in the write path, built after the snapshot pipeline is solid | Matches arch §12's own ordering ("build only after the write path is solid") |
| Read/write split | **Kept exactly** — cron computes + overwrites snapshots; read route serves stored JSON, zero Jira calls | Arch §3 is the load-bearing idea and survives re-grounding unchanged |
| Pure logic location | `worker/src/risk/logic/` — **not** `shared/` | Snapshot carries every computed value the client needs (values, bands, scores, *and* each ticket's resolved warn/risk thresholds), so the client never recomputes. One consumer → YAGNI (arch §2's own rule). Only wire types go in `shared/src/risk.ts` (precedent: `shared/src/notifications.ts`) |
| DB access | Feature-owned store `worker/src/risk/store.ts` over `env.DB` directly — `dao.ts` untouched | Precedent: `worker/src/notifications/adapters/zulip/store.ts` (feature-owned tables, boundary stated in the header comment). Keeps the privacy-invariant file completely out of the diff |
| Work-hours clock | Port the userscript's Intl-based timezone math, generalized to a config-driven `{timeZone, days}` schedule; NY Mon–Thu 9–18 / Fri 9–13 default | Proven algorithm, zero new deps, identical behavior in workerd/Node/browser. A **documented exception** to the repo's `UTCDate` convention (which already has two wall-clock exceptions: `workdayPace`, `trackerDayKey`) |
| On-demand refresh | **Not in v1** — cron-only; read route returns `refreshing: true` when no snapshot exists yet | `route()` doesn't currently thread `ExecutionContext`; worst case a first-time viewer waits ≤3 min. Threading `ctx.waitUntil` in later is a contained ~4-line follow-up |
| Config secrecy | Plain columns, **no encryption** | Board ids, cutoff tables, an account id — nothing secret (unlike Zulip's API keys). `secretbox.ts` not needed |
| Privacy invariant | **Untouched.** The snapshot shows per-ticket/per-assignee **Jira** data that every org member can already see in Jira — not self-rated effort. `dao.ts` / `privacy.test.ts` are not modified; org scoping via `ctx.cloudId` still enforced | The invariant guards effort ratings, not Jira's own data. State this in the routes-file header so a future reader doesn't conflate them |

---

## 1. Phase 0 — pure logic port + tests (no schema, no routes, no UI)

Zero Cloudflare/Jira dependencies. Highest value, lowest risk — do first (arch §12 steps 1–2).

### New files

**`shared/src/risk.ts`** — wire types only, no logic:

- `RiskBand = 'ok' | 'warn' | 'risk' | 'none'`
- `RiskMetricId = 'rejections' | 'blocked' | 'idle' | 'timeInColumn' | 'cycle'`
- `RiskCutoffRule { column?: string; size?: number | 'none'; warn?: number; risk?: number; default?: boolean }`
- `RiskCutoffs { idle: RiskCutoffRule[]; cycle: RiskCutoffRule[]; timeInColumn: RiskCutoffRule[] }`
- `RiskCompositeConfig { p: number; weights: Partial<Record<RiskMetricId, number>> }`
- `RiskWorkSchedule { timeZone: string; days: Record<'Mon'|'Tue'|'Wed'|'Thu'|'Fri'|'Sat'|'Sun', [open: number, close: number] | null> }`
- `RiskTicket` (below), `RiskBoardSnapshot`, `RiskTierCounts`
- Route contracts: `RiskBoardsResponse`, `RiskBoardResponse`, `RiskAdminConfigResponse`, `PutRiskConfigRequest`, `RiskBoardCandidatesResponse`, `RiskFieldCandidatesResponse`

Per-ticket snapshot shape (adapted from `rbMapIssue`, plus server-side scoring so the client does zero math):

```ts
interface RiskTicket {
  key: string; summary: string; type: string; status: string; column: string;
  assignee: string | null; avatarUrl: string | null; points: number | null;
  parentKey: string | null; implementor: string | null; codeReviewer: string | null;
  rejections: number | null; blocked: boolean; blockedByOpen: string[];
  unassignedInProgress: boolean; done: boolean; started: boolean;
  idleHours: number | null; timeInColumnHours: number | null; cycleHours: number | null;
  metrics: Record<RiskMetricId, {
    value: number | boolean | null; band: RiskBand; score: number | null;
    warn?: number; risk?: number;          // the ticket's OWN resolved thresholds (detail view)
  }>;
  composite: { score: number | null; band: RiskBand };
  tier: RiskBand | null;                   // worst firing band; null = all pending
  columnTotals: { column: string; hours: number; visits: number }[];
  flow: { createdAt: string; startedAt: string | null; columnSegs: unknown[]; assigneeSegs: unknown[]; totalHours: number };
  recentUpdaters: string[];
  prs?: RiskPr[];                          // present only if the dev-status probe passed
}
```

`RiskBoardSnapshot` = `{ boardId, boardName, columns: string[], tickets: RiskTicket[] (sorted composite desc), tierCounts, cutoffs, composite, schedule, computedAt }` — the effective config is echoed so the detail view can show it.

**`worker/src/risk/logic/workhours.ts`** — `makeWorkClock(schedule: RiskWorkSchedule)` → `{ workMs(start, end), workMsWithin(from, to, intervals) }`. Ports `rbNyParts` / `rbOffsetMs` / `rbNyWallToUtc` / `rbWorkMs` (userscript L304–332) and `rbWorkMsWithin` (L507–514), parameterized by schedule instead of hardcoded `RB_TZ`/`RB_WORK`. Consolidates the duplicate `flowWorkMs` copy in the HTML blob to one implementation (arch §10 note).

**`worker/src/risk/logic/timers.ts`** — `reduceTimers(...)` ports `rbReduceTimers` (L458–505), taking a `workMs` function. Preserve exactly:
- Done-column segments excluded; `sittingInDone` freezes `clockEnd` at the last Done entry (Done is a **pause**, not a stop — pulled-back tickets resume).
- Idle anchor = max(last segment start, last assignee change ≤ `clockEnd`) — idle resets on status **or** assignee change.
- `started` = first entry into the configured In Progress status; before that, idle/in-column/cycle are **null, not zero**.
- While sitting in Done, in-column uses the last non-Done column.

Also `recentUpdaters(events, nowMs, windowMs)` (L371–378).

**`worker/src/risk/logic/segments.ts`** — `buildSegments(...)` ports `rbBuildSegments` (L516–588): `columnTotals` (hours + visits, adjacent-merge), flow timeline (columnSegs with Done stubs **kept**, assigneeSegs clipped at first-In-Progress, totalHours over cycle intervals).

**`worker/src/risk/logic/scoring.ts`** — ports from the HTML blob (markers `SCRUM_ENGINE_*` bracket the testable region; scoring functions sit nearby):
- `FIB_BUCKETS = [1,2,3,5,8,13,20]`, `sizeBucket(points)` (null → `'none'`, overflow clamps to 20).
- `resolveCutoff(metric, column, points)` — **most-specific-first**: column+size > column-only > size-only > `default` rule > `HARD_FALLBACK = { idle:{24,72}, cycle:{160,240}, timeInColumn:{24,56} }`; independent of rule order; a rule counts only with real warn+risk numbers.
- `band(v, {warn, risk})` (the blob's `tband`: v≥risk → `'risk'`, v≥warn → `'warn'`, else `'ok'`), constants `REJ = {warn:2, risk:4}`, `COMP = {warn:0.7, risk:1.0}`.
- `compositeScore(scores, cfg)` — weighted power-mean `(Σ w·max(0,s)^p / Σw)^(1/p)`, `p` default 2, null scores excluded, null when no contributors. Reimplemented **without** the userscript's `state.order`/`state.on` viewer toggles: the server always computes with all five metrics in fixed order.

**`worker/src/risk/logic/health.ts`** — the `HEALTH` registry semantics as `evaluateTicket(raw, cutoffs, composite, columns)` → the `metrics`/`composite`/`tier` fields of `RiskTicket`. Exact rules:
- Done-column ticket → every metric band `'none'`, score null, composite null, tier null, excluded from tier counts — raw values still present ("keep showing, stop flagging").
- Not-started ticket → idle/in-column/cycle band `'none'`/score null.
- `rejections` band `'ok'` when 0; `blocked` binary (score 1/0, band risk/ok).
- `cardTier` = worst non-none band; `tierCounts` = `{risk, warn, ok}` over non-done tickets.

**`worker/src/risk/logic/defaults.ts`** — `DEFAULT_CUTOFFS` (the userscript `riskCutoffs` tables L85–245, verbatim), `DEFAULT_COMPOSITE` (`p: 2`, weights from L248–257 **minus `unassignedWip`** — dead config, see "not ported"), `DEFAULT_SCHEDULE` (America/New_York, Mon–Thu 9–18, Fri 9–13), `DEFAULT_IN_PROGRESS = 'In Progress'`.

### Phase 0 tests (vitest, run via `npm test`)

- **`worker/test/risk-workhours.test.ts`** — golden values for: a span within one workday; spanning a weekend; Friday 13:00 close; **DST spring-forward (2026-03-08) and fall-back (2026-11-01)** in America/New_York; zero/negative ranges; a non-NY schedule (proves config-drivenness).
- **`worker/test/risk-timers.test.ts`** — never started (all null, `started: false`); simple In Progress → now; Done pause then pulled back (clocks resume, Done interval excluded); currently sitting in Done (frozen, in-column = last non-Done column); idle reset by assignee change vs status change; assignee change after `clockEnd` ignored.
- **`worker/test/risk-segments.test.ts`** — columnTotals merge + visit counts, Done stubs kept, assignee segs clipped at first-IP, totalHours.
- **`worker/test/risk-scoring.test.ts`** — `sizeBucket` (null→'none', 4→5, 100→20); `resolveCutoff` specificity independent of table order + fallback chain to `HARD_FALLBACK`; `compositeScore` (null exclusion, weights, p=1 vs p=2, all-null → null); `evaluateTicket` done-column → band 'none'/tier null; `tierCounts`. Pin a couple of hand-computed composite goldens.

**Exit criteria:** `npm test` + `npm run typecheck` green. The only existing file modified is `shared/src/index.ts` (+1 line: `export * from './risk';`).

---

## 2. Phase 1 — schema, refresh engine, routes, UI

### 2a. Schema

**`migrations/0010_risk_board.sql`** (idempotent `CREATE TABLE IF NOT EXISTS`, next number after `0009`) and a mirrored block appended to **`worker/src/db/schema.sql`** with the standard keep-in-sync comment and a boundary header ("accessed ONLY by `worker/src/risk/store.ts` via `env.DB` — never `dao.ts`", mirroring the Zulip tables' convention):

```sql
-- Per-org risk-board config, admin-entered. Nothing here is secret (board ids,
-- cutoff tables, a refresher account id) — plain columns, no encryption.
CREATE TABLE IF NOT EXISTS risk_board_config (
  cloud_id             TEXT PRIMARY KEY,
  boards_json          TEXT NOT NULL DEFAULT '[]',  -- [{boardId:number, name:string}]
  cutoffs_json         TEXT,    -- RiskCutoffs; NULL = code defaults
  composite_json       TEXT,    -- {p, weights}; NULL = code defaults
  work_schedule_json   TEXT,    -- RiskWorkSchedule; NULL = NY default
  fields_json          TEXT,    -- {flagged?, rejections?, implementor?, codeReviewer?} customfield ids
  in_progress_status   TEXT,    -- NULL = 'In Progress'
  dev_status_available INTEGER, -- NULL = unprobed; 0/1 = probe result (gates the PR feature)
  refresher_account_id TEXT,    -- whose oauth_tokens row the cron refresher uses
  configured_by        TEXT,
  updated_at           TEXT NOT NULL
);

-- One snapshot per board, overwritten each refresh (write path); read path serves it.
CREATE TABLE IF NOT EXISTS risk_snapshots (
  cloud_id      TEXT NOT NULL,
  board_id      INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,   -- RiskBoardSnapshot blob
  computed_at   TEXT NOT NULL,   -- ISO UTC
  PRIMARY KEY (cloud_id, board_id)
);

-- Demand-driven refresh state.
CREATE TABLE IF NOT EXISTS risk_board_state (
  cloud_id        TEXT NOT NULL,
  board_id        INTEGER NOT NULL,
  last_viewed_at  TEXT,             -- set by the read route (the demand signal)
  last_refresh_at TEXT,             -- last successful refresh
  last_attempt_at TEXT,
  failures        INTEGER NOT NULL DEFAULT 0,   -- consecutive; reset on success
  degraded_reason TEXT,             -- NULL | 'needs_reauth' | 'errors'
  PRIMARY KEY (cloud_id, board_id)
);
```

**Reserved for Phase 2** (sketched now, created in a later `0011_risk_alerts.sql` — don't ship an unused table):

```sql
CREATE TABLE IF NOT EXISTS risk_alert_state (
  cloud_id          TEXT NOT NULL,
  issue_key         TEXT NOT NULL,
  phase             TEXT NOT NULL DEFAULT 'armed',  -- armed|firing|recovered (hysteresis)
  risk_streak       INTEGER NOT NULL DEFAULT 0,     -- consecutive refreshes at risk
  last_notified_at  TEXT,
  last_payload_hash TEXT,                           -- dedupe identical re-sends
  PRIMARY KEY (cloud_id, issue_key)
);
```

### 2b. Worker: Jira access

**`worker/src/risk/jira.ts`** — thin layer over the existing `JiraClient.get<T>()` (`worker/src/jira/client.ts`):

- `fetchBoardMaps(client, boardId)` → `GET /rest/agile/1.0/board/{id}/configuration` → `{ columnNames, statusToColumn, firstCol, doneColStatusIds }` where **Done = the LAST column by position** (ports `rbFetchBoardMaps`, L646–658). **Probe #1** — run at admin config time; fail loudly with a scope-specific message if the granular scopes don't cover it.
- `fetchDoneStatusIds(client)` → `GET /rest/api/3/status` → statusCategory-done ids (ports `rbFetchDoneStatusIds`, L451–456).
- `pageBoardIssues(client, boardId, fields)` — ports `rbPageAgile` + the board/sprint walk of `rbBuildBoard` (L335–346, 660–673): scrum board → active sprints → `/board/{id}/sprint/{sid}/issue`; else `/board/{id}/issue`; `startAt`/`maxResults=50`; request only base fields + configured optional customfields.
- `fetchChangelog(client, issueId)` — ports `rbFetchHistory` (L348–367): pages `/rest/api/3/issue/{id}/changelog` (100/page) → `{ status[], assignee[], events[] }`. **Probe #3** — documented under classic `read:jira-work`; verify once during build.
- `fetchPullRequests(client, issueId)` — ports `rbFetchPullRequests`/`rbNormalizePR` (L393–449) **behind a probe**: on first refresh per org, try `/rest/dev-status/latest/issue/summary` once; on 401/403/404 persist `dev_status_available = 0` and never call again (`prs` omitted — the userscript's own graceful-drop contract). **Probe #2** — likely unavailable via `api.atlassian.com` OAuth; the plan assumes it drops (arch §8: "drop the PR feature rather than faking it").
- `sleep(ms)` pacing helper.

**One small core touch (recommended):** add `JiraApiError extends Error { status: number }` thrown by `JiraClient.get()` so 429 detection isn't string matching. Backwards-compatible; benefits all callers. (Zero-core-diff fallback: match the status in the error message from risk code.)

### 2c. Worker: refresh engine — built for dozens of orgs from day one

**`worker/src/risk/refresh.ts`** — the write path, 4th isolated cron job.

Capacity math that shapes it: the hard per-invocation ceiling is **~1,000 subrequests** (Workers paid). One board refresh ≈ board calls + N issues × (1–2 changelog pages) ≈ **35–65 Jira calls**. Budgeting ~600 subrequests/tick → **~10–15 board refreshes/tick ≈ 240+/hour** — comfortably serves a few dozen orgs at hourly idle cadence plus 5-minute cadence for the handful of actively-viewed boards. CPU is a non-issue (paced awaits are unbilled — arch §7 holds).

`refreshRiskBoards(env, dao, log)` per tick:

1. **Eligibility** (demand-driven, arch §6 simplified): for each configured board, refresh if
   - viewed within 30 min AND snapshot older than 5 min (**active**), or
   - snapshot older than 60 min (**idle**), else skip.
   Add per-board deterministic jitter (derived from `hash(cloudId, boardId)`, ± a few minutes on the 60-min threshold) so hourly refreshes stagger across ticks instead of aligning on the same tick.
2. **Scheduling**: collect all eligible boards fleet-wide; order by staleness (oldest `last_refresh_at` first) with **round-robin fairness across orgs** (interleave so one org's many boards can't starve another org). Process serially under the **per-tick subrequest budget** (~600; each board pre-charges an estimate, actuals tracked): when the budget is spent, stop — the remainder is naturally picked up next tick (the `cron/pd-report.ts` resume pattern, generalized).
3. **Per-org unit**: `refreshOrg(env, cfg, boards, log)` — fetch the refresher's token (`dao.getToken(cfg.refresherAccountId)`); missing/`needs_reauth` → `markDegraded('needs_reauth')` for that org's boards and continue with other orgs; else one `JiraClient` per org (token invocation-scoped — never module-global, per arch §2's token-scoping rule, which still applies inside one Worker).
4. **Per-board**: `refreshBoard(client, cfg, boardId, now)` — board maps → issues → per-issue changelog with `await sleep(200)` between Jira calls (per-tenant rate limits are per-org; orgs are serialized, so pacing inside the org loop controls the org's request rate exactly as arch §5 intends) → `mapIssue` (ports `rbMapIssue` L590–644: **blocked = configured flagged field truthy OR an open inward "Blocks" link** whose blocker is neither statusCategory-done nor in the board's done column; optional fields null-safe when unconfigured) → `logic/*` timers/segments/health → assemble `RiskBoardSnapshot` (tickets sorted by composite desc) → `store.overwriteSnapshot()` → `store.recordSuccess()`. Overwrite-only = **idempotent** (safe under any re-run).
5. **Error isolation**: a 429 or transient error in one org records failure/backoff for that org's boards and **skips only that org for the rest of the tick** — other orgs proceed. Other per-board errors → `recordFailure()` (consecutive failures ≥ 5 → `degraded_reason = 'errors'`; reset on success). The job itself never throws past its cron try/catch.
6. **Phase-2 seam** — one marked call site between "snapshot computed" and "overwrite":
   `// PHASE 2: diff vs prior snapshot + risk_alert_state hysteresis here (arch §9)`.
7. **Scale-up seam** — `refreshOrg` is deliberately self-contained: if the fleet ever outgrows the cron budget, its body becomes the Queue consumer's per-message handler ("one message per company", arch §5) with no rewrite. That is the documented graduation path; the trigger is sustained refresh backlog (boards regularly missing cadence / budget consistently exhausted — instrument per-org Jira-call counts from day one, arch §7's advice kept).

**`worker/src/risk/store.ts`** — all `risk_*` SQL via `env.DB` (Zulip-store pattern; boundary stated in header): `getConfig` / `putConfig` / `listConfigs`, `overwriteSnapshot` / `getSnapshot`, `getState` / `markViewed` / `recordSuccess` / `recordFailure` / `markDegraded`, `deleteBoardState` (cleanup when a board is removed from config).

### 2d. Worker: routes

**`worker/src/risk/routes.ts`** — two exported dispatchers so `worker/src/index.ts` gains only two lines. Header comment states the privacy distinction (Jira-visible data, not effort ratings; `ctx.cloudId` scoping enforced).

Authed tier — `riskRoutes(req, ctx, path, method)`:
- `GET /api/risk/boards` → configured boards for `ctx.cloudId`: `{ boardId, name, computedAt | null, degradedReason, tierCounts | null }` per board.
- `GET /api/risk/board/:id` → `{ snapshot | null, computedAt, degradedReason, refreshing }`; **side effect: `store.markViewed()`** (the demand signal). 404 if not in the org's config. Zero Jira calls.
- `POST /api/__dev/risk/refresh` — dev-only immediate refresh (guarded like `routes/dev.ts`; 404 in prod) since cron doesn't tick under plain `wrangler dev`.

Admin tier — `riskAdminRoutes(req, ctx, path, method)` (registered inside the existing `requireAdmin` block, gating inherited):
- `GET /api/admin/risk/config` → current config + defaults echoed (nothing secret → values readable back, unlike Zulip's write-only secrets).
- `PUT /api/admin/risk/config` → validate (numeric board ids; cutoffs/weights/p shape; schedule day keys + hours; **timezone validated by constructing `Intl.DateTimeFormat`**; refresher account has a token) and upsert; default `refresher_account_id` to `ctx.accountId` on first save (mirrors `configureChannel`'s audit pattern).
- `GET /api/admin/risk/boards` → live board candidates via existing `listBoards` (`worker/src/jira/search.ts:86`) using the admin's own token; runs **probe #1** against the selected board and reports scope failures with a specific message.
- `GET /api/admin/risk/fields` → candidate custom fields for flagged/rejections/implementor/codeReviewer by name-matching `/rest/api/3/field` (risk-owned helper — do **not** modify `worker/src/jira/fields.ts`); all optional. Custom-field ids are **never hardcoded** (repo invariant).

### 2e. Registration touchpoints — the complete list of existing-file changes

| File | Change |
|---|---|
| `worker/src/index.ts` | 2 imports; 4th isolated cron job in `scheduled()` (`try { await refreshRiskBoards(...) } catch { log }`); 2 route lines (`/api/risk*` → `riskRoutes`, `/api/admin/risk*` → `riskAdminRoutes`) |
| `worker/src/jira/client.ts` | `JiraApiError` with `status` (optional but recommended) |
| `worker/src/db/schema.sql` | append `risk_*` block (keep-in-sync comment) |
| `shared/src/index.ts` | `export * from './risk';` |
| `client/src/app/app.routes.ts` | one lazy route: `{ path: 'risk', loadChildren: () => import('./risk/risk.routes').then(m => m.RISK_ROUTES) }` |
| `client/src/app/app.component.ts` | one nav link |
| `client/src/app/api.service.ts` | one comment-delimited `// --- risk board (delete with client/src/app/risk) ---` block of typed methods |
| `client/src/webawesome.ts` | imports for newly used `<wa-*>` elements (expected: `details`, `tooltip`, `divider`; tag/dialog/button/select/spinner/callout already registered) |
| `client/src/styles.css` | add `--warn` (amber) + `--risk` (red) to **both** `.wa-dark` and `.wa-light` |

That table **is** the deletion story's "unregister" list — nothing else in the core app may reference the feature.

### 2f. Client UI — `client/src/app/risk/` (own directory)

- **`risk.routes.ts`** — feature sub-routes: `''` → board page; `admin` → config page (component re-checks `auth.isAdmin()`; server enforces for real, matching the repo's no-route-guard convention).
- **`risk-board.component.ts`** — the triage list (arch §11, kept as designed): board picker (if >1 configured); summary chips `N at risk · N warning · N healthy` from `tierCounts` (`wa-tag` variant pills — dynamic-variant pattern from `admin.component.ts:191`); rows already sorted by composite server-side; each row = key + summary + column pill, **firing metrics only** as pills in priority order (blocked w/ blocker keys > idle > in-column > cycle > rejections), `sp-avatar` assignee (`ui/avatar.component.ts`), left tier stripe via `--risk`/`--warn`, healthy rows faded; degraded banner ("refresh degraded — refresher needs re-login", admin sees detail); "updated Xm ago" from `computedAt`; `refreshing: true` empty state polls until a snapshot lands. Standalone + signals + `CUSTOM_ELEMENTS_SCHEMA`.
- **`risk-detail.component.ts`** — `wa-dialog` bound to a `selected` signal with `(wa-after-hide)` close (`tracker.component.ts:206–225` pattern): full metric rundown showing each ticket's **own resolved warn/risk thresholds** (straight from `metrics[id].warn/risk` — no client math); per-column time bars from `columnTotals` (plain CSS bars, colored by the column's band); PRs section only when `prs` present. **Flow-timeline SVG deferred** — the flow data already ships in the snapshot, so it's a pure client add later, no backend change.
- **`risk-admin.component.ts`** — board picker (candidates endpoint), refresher-account select (existing `orgMembers()` API), optional field pickers, cutoffs/composite editors (v1: raw JSON in `wa-textarea` + server-side validation; friendlier editors later), work-schedule editor, save via `putRiskConfig`.
- **`format.ts`** — `fmtWorkHM` port (8-hour-workday `Nd Nh Nm` formatting) + pill/label helpers.

### Phase 1 tests

- **`worker/test/risk-store.test.ts`** — via `schema.sql` + `test/support/sqlite-d1.ts`: config upsert/JSON round-trip; snapshot overwrite (one row after two writes); markViewed / recordSuccess / recordFailure (degraded at 5, reset on success); board-removal cleanup.
- **`worker/test/risk-refresh.test.ts`** — `refreshBoard`/`refreshRiskBoards` against a stubbed structural client (`{ get<T>(path) }` returning canned board-config/issues/changelog JSON):
  - snapshot golden (bands, tier, sort order, blocked logic, done-column freeze);
  - **idempotency**: run twice → identical snapshot, single row;
  - eligibility matrix (active-fresh skip / active-stale refresh / idle <60 min skip / >60 min refresh);
  - **multi-org scheduling**: budget exhaustion stops mid-fleet and resumes next tick; org-fair interleaving; one org's 429/reauth degrades only that org while others complete; jitter staggers hourly refreshes;
  - `needs_reauth` → degraded, zero Jira calls for that org.
- **`worker/test/risk-routes.test.ts`** — boards/board wiring; board GET marks viewed; unknown board 404; admin routes unreachable without admin; PUT config validation errors (incl. bad timezone); dev refresh 404 outside dev env.

### Phase 1 verification (manual, `wrangler dev` against real Jira)

1. `npm run db:migrate` (local), `npm run dev`, log in via real OAuth.
2. Admin flow at `/risk/admin`: board candidates load (agile list under real scopes) → selecting a board runs **probe #1** (`/board/{id}/configuration` under `read:board-scope:jira-software` + `read:project:jira`) → save config.
3. Trigger a refresh: `POST /api/__dev/risk/refresh` (or `wrangler dev --test-scheduled` + `curl 'http://localhost:8787/__scheduled?cron=*/3+*+*+*+*'`). Watch structured logs for the paced fetch; confirm **probe #3** (changelog) succeeds and **probe #2** (dev-status) degrades gracefully to `dev_status_available = 0`.
4. `GET /api/risk/board/:id` returns the snapshot with zero Jira calls; open `/risk` and **compare bands/tiers against the live userscript on the same board** — the real golden test.
5. Degraded path: locally set the refresher's `needs_reauth = 1` → banner appears, refresh skipped, other orgs (seed a second config row) unaffected.
6. `npm test`, `npm run typecheck`, `npm run lint` (the `wrangler.toml [build]` gate runs tests before deploy anyway).

---

## 3. Phase 2 — health-change notifications (later; hooks reserved now)

Out of scope for the current build. What Phase 1 leaves ready:

- The marked **seam** in `refresh.ts` (between snapshot-compute and overwrite) where arch §9's diff step slots in: load `risk_alert_state`, update streak/phase under hysteresis, collect edge-transitions into firing, aggregate per recipient, deliver via the existing `notifications/registry.resolve()` seam — exactly how `cron/escalate.ts` reaches channels today; adapters are never touched directly (eslint walls enforce this).
- The `risk_alert_state` sketch → `migrations/0011_risk_alerts.sql` when built.
- The snapshot already carries per-ticket `tier`/`composite` (the state machine's input); the work clock is a reusable module (quiet-hours gating).
- All of arch §9's product rules carry over unchanged: hysteresis + transition-only firing, ticket-level alert with metric-level payload, per-human aggregation, private-to-dev default routing.

---

## 4. Port-mapping table

| Userscript (line refs in `0_userscript.js`) | New location |
|---|---|
| `rbNyParts` / `rbOffsetMs` / `rbNyWallToUtc` / `RB_WORK` / `rbWorkMs` (L304–332) | `worker/src/risk/logic/workhours.ts` `makeWorkClock(schedule)` |
| `rbWorkMsWithin` (L507–514) + duplicate `flowWorkMs` (blob) | same module — single implementation |
| `rbReduceTimers` (L458–505) | `worker/src/risk/logic/timers.ts` `reduceTimers` |
| `rbRecentUpdaters` (L371–378) | `timers.ts` `recentUpdaters` |
| `rbBuildSegments` (L516–588) | `worker/src/risk/logic/segments.ts` `buildSegments` |
| `FIB_BUCKETS` / `sizeBucket` (blob) | `worker/src/risk/logic/scoring.ts` |
| `resolveCutoff` / `HARD_FALLBACK` (blob) | `scoring.ts` `resolveCutoff` |
| `tband` / `REJ` / `COMP` (blob) | `scoring.ts` `band` + constants |
| `compositeScore` (blob; minus viewer toggles) | `scoring.ts` `compositeScore` |
| `HEALTH` registry + `metricValue` / `cardTier` / `tierCounts` (blob) | `worker/src/risk/logic/health.ts` `evaluateTicket` / `cardTier` / `tierCounts` |
| `RB_CFG.riskCutoffs` / `composite` / `inProgressStatus` (L76–288) | `logic/defaults.ts` + per-org DB config overrides |
| `rbFetchHistory` (L348–367) | `worker/src/risk/jira.ts` `fetchChangelog` |
| `rbFetchBoardMaps` (L646–658) | `risk/jira.ts` `fetchBoardMaps` |
| `rbFetchDoneStatusIds` (L451–456) | `risk/jira.ts` `fetchDoneStatusIds` |
| `rbPageAgile` (L335–346) + board/sprint walk of `rbBuildBoard` (L660–673) | `risk/jira.ts` `pageBoardIssues` |
| `rbFetchPullRequests` / `rbNormalizePR` (L393–449) | `risk/jira.ts` `fetchPullRequests` (probe-gated, graceful drop) |
| `rbMapIssue` (L590–644) | `worker/src/risk/refresh.ts` `mapIssue` |
| `rbBuildBoard` (L660–673) | `refresh.ts` `refreshBoard` |
| `RB_FIELDS` hardcoded customfield ids (L279–293) | discovered/admin-configured via `fields_json` (never hardcoded — repo invariant) |
| `fmtWorkHM` (blob) | `client/src/app/risk/format.ts` |
| Detail modal (blob UI) | `client/src/app/risk/risk-detail.component.ts` (redesigned per arch §11) |

## 5. What NOT to port (and why)

- **Iframe/overlay/postMessage bridge, launcher button, the `RB_BOARD_HTML` blob** (L675–788): existed only because the script had no server; the SPA + `/api` replaces the transport entirely (arch §10 says discard).
- **localStorage prefs (`rbLoadPrefs`/`rbSavePrefs`) + URL-state persistence**: viewer-side metric toggles/ordering contradict server-side scoring; theme is owned by `ThemeService`; config is per-org in v1.
- **Daily Scrum mode, Dev/PM view switch, developer/tier filters, search**: full-board UX the triage list deliberately omits (arch §11 — Jira does boards; we ship the exception signal). Client-side filters can return later with no backend change since the full snapshot ships.
- **`unassignedWip` composite weight**: dead config — the blob's `compositeScore` iterates only registered `HEALTH` metrics, which never included `unassignedWip`. The `unassignedInProgress` **field** stays in the snapshot (cheap, displayable); the weight is dropped rather than inventing a metric the original never scored.
- **`retrospectivePoints` field**: fetched by the userscript but unused by any metric or the target UI; skipped.
- **Per-viewer recompute-on-view model**: replaced by the snapshot write/read split (the whole point — arch §3).

## 6. Deletion story (exact)

1. `rm -rf worker/src/risk client/src/app/risk shared/src/risk.ts worker/test/risk-*.test.ts`
2. Remove the registration lines listed in §2e (each ≤ a few lines, all enumerated there).
3. New migration `NNNN_drop_risk_board.sql`: `DROP TABLE IF EXISTS risk_board_config; ... risk_snapshots; ... risk_board_state;` (+ `risk_alert_state` if Phase 2 shipped); delete the block from `schema.sql`.
4. Optionally revert `JiraApiError` (harmless to keep).

Nothing in `dao.ts`, the privacy tests, the notification adapters, or the OAuth subsystem changes in either direction.

## 7. Risks / open questions

1. **Probe #1 — board-configuration endpoint scope.** Should be covered by `read:board-scope:jira-software` + `read:project:jira`, but the Agile API's granular-scope behavior has bitten this repo before (see the scope war stories in `README.md`). If it fails: scopes change ⇒ **every user must re-consent** (scopes freeze at consent) — the expensive branch; that's why the probe runs at admin-config time, before anything ships.
2. **Probe #2 — dev-status PR data**: undocumented endpoint, almost certainly absent via `api.atlassian.com` OAuth. Plan assumes graceful drop; probe once per org, persist, omit `prs`.
3. **Probe #3 — per-issue changelog under OAuth**: documented under classic `read:jira-work`; low risk, verified in step 3 of Phase 1 verification.
4. **Changelog volume**: ~35–65 calls/board at 200 ms pacing ≈ 10–15 s wall-clock/board, serial, budget-capped per tick — comfortably inside a cron invocation (CPU-billed; awaits free). Future optimization (not v1): skip re-fetching changelogs for issues whose `updated` timestamp hasn't changed.
5. **Work-schedule validation**: a bad timezone string throws in `Intl.DateTimeFormat` — validated at `PUT` time.
6. **Snapshot size**: ~30 tickets with flow segs ≈ tens of KB JSON — fine in D1 TEXT; no R2 needed at this scale.
7. **Refresher bus factor**: if the designated refresher leaves/revokes, that org silently degrades — surfaced via `degraded_reason` in user + admin UI; admin re-designates.

## 8. Build order

1. Phase 0 (pure logic + tests) — mergeable alone; no schema, no routes.
2. Migration `0010` + `schema.sql` + `store.ts` + store tests.
3. `risk/jira.ts` + `refresh.ts` + refresh tests; wire the cron job; verify against real Jira (probes).
4. Routes + route tests + `shared` contracts + `ApiService` block.
5. Client: triage list → detail modal → admin config page.
6. (Later) Phase 2 notifications per §3.
