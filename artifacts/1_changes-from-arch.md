# Changes from `0_arch.md` — deviation record

Companion to `1_replacement-plan.md`. The arch doc was written against an
**assumed ~1,000-tenant SaaS** (its §1 "business model (assumed)"); the plan is
grounded in the repo as it exists — one Cloudflare Worker (API + SPA, one
deploy), org = Jira site (`cloud_id`), per-**user** rotating OAuth tokens, a
3-minute cron with serial isolated jobs, D1 only (no Queues/KV/R2), notification
adapters behind an eslint-walled registry — and in the **confirmed scale
target: one org today, a few dozen orgs tomorrow** (not 1,000).

The arch doc's §13 says "don't relitigate without new information." The new
information is exactly that grounding: the fleet the queues/Workers topology was
designed for does not exist, and the repo already contains the seams (cron
isolation, module walls, per-org config precedent) the arch doc wanted to build.
Each entry below records: the arch position → what the plan does instead → why →
what would trigger reverting to the arch position.

## Infrastructure deviations

### 1. Separate scheduler / consumer / read-path Workers → one Worker, directory-isolated module
- **Arch (§2, §4):** separate Worker for the risk board; core exposes tokens/prefs/notifiers over a service binding.
- **Plan:** the feature lives inside the existing Worker: `worker/src/risk/` (+ `client/src/app/risk/`, `shared/src/risk.ts`), its own `risk_*` tables, a 4th isolated cron job, its own routes file.
- **Why:** the repo is a single deploy; a second Worker means a second wrangler config, deploy pipeline, and binding surface — real solo-dev cost buying isolation the repo already provides via module walls (the Zulip adapter precedent). The arch doc's *top* constraint — easy to delete — is preserved: deletion = `rm` three paths + ~10 enumerated registration lines + one drop-tables migration (`1_replacement-plan.md` §6). A bad risk-board deploy is still gated by the same test suite that gates the tracker (`wrangler.toml [build]` runs `npm test` first); the cron job is try/catch-isolated like the existing three.
- **Revert trigger:** the feature grows its own deploy cadence or failure modes that endanger the tracker (e.g. long-running consumers), or fleet size approaches the hundreds.

### 2. Cloudflare Queues + DLQ ("one message per company") → budget-scheduled cron job
- **Arch (§4–§5):** scheduler enqueues one message per tenant; a queue consumer fans out with retries, backpressure, DLQ.
- **Plan:** a 4th cron job with a **per-tick Jira-subrequest budget** (~600 of the ~1,000/invocation cap), staleness-ordered, **round-robin-fair across orgs**, deterministic per-board jitter, per-org error isolation (one org's 429/reauth skips only that org this tick), resume-next-tick for whatever the budget didn't cover (generalizing the existing `cron/pd-report.ts` pattern).
- **Why:** no queue binding exists, and the capacity math works without one: ~50 Jira calls/board ⇒ ~10–15 board refreshes/tick ≈ **240+/hour**, which serves a few dozen orgs at hourly idle cadence + 5-min active cadence with a wide margin. The queue's real jobs at 1,000 tenants — fan-out, retries, DLQ — are handled at this scale by budget+resume, `risk_board_state.failures`, and `degraded_reason` respectively.
- **What's preserved from the arch's queue reasoning:** per-org serialization of Jira calls (rate limits are per-tenant — arch §5's load-bearing point survives: orgs are processed serially, paced inside the org loop), idempotent overwrite-only snapshots, "a permanently broken tenant must not retry forever" (degraded state instead of DLQ).
- **Deliberate graduation seam:** `refreshOrg(env, cfg, boards, log)` is self-contained — its body becomes the queue consumer's per-message handler with no rewrite.
- **Revert trigger:** sustained refresh backlog (boards regularly missing their cadence) or the per-tick budget consistently exhausted — instrument per-org Jira-call counts from day one (arch §7's advice, kept) so this is measured, not guessed.

### 3. Per-tenant OAuth (company installs the app) → admin-designated per-org refresher account
- **Arch (§8):** each company authorizes the app once; the service stores the tenant's refresh token.
- **Plan:** the cron refresher uses an existing **user** token: an admin designates `refresher_account_id` per org (defaults to the admin saving the config), read from the existing `oauth_tokens` table. `needs_reauth`/missing token → that org's boards marked degraded and surfaced in the UI; admin re-designates.
- **Why:** the repo's entire auth model is per-user 3LO with rotating refresh tokens shared across sites; a tenant-grant concept doesn't exist and would be a new OAuth subsystem. The per-org admin-config pattern (`zulip_org_config`) is the established repo idiom for "an admin wires up this org."
- **Cost accepted:** refresher bus factor (recorded as risk #7 in the plan) — mitigated by visible degradation, not hidden failure.
- **Revert trigger:** actual external customers whose admins won't tie a personal grant to a service function — that's the point to build tenant-level install.

### 4. Service-binding contracts (`getJiraToken`, `getUserPrefs`, `sendToNotifiers`) → direct in-process reuse
- **Arch (§2):** core exposes token/prefs/notification methods over a Worker-to-Worker binding; risk board is a pure consumer.
- **Plan:** same *boundary*, no *transport*: the risk module calls the existing `JiraClient` (which owns token lifecycle — refresh, rotation, `needs_reauth`) and reaches notification channels only through `notifications/registry.resolve()` exactly as `cron/escalate.ts` does. Eslint walls already prevent the risk code from touching adapters or their tables.
- **Why:** in one Worker, the arch's "core owns token lifecycle; consumer owns token use" contract is satisfied by the module seam itself. The token-scoping rule (§2's one real bug-risk) still applies and is kept: client instances are invocation-scoped per org, never module-global.

### 5. Iframe frontend + postMessage bridge → lazy Angular route
- **Arch (§2, "leaning"):** iframe, reusing the userscript's postMessage pattern, as the most disposable option.
- **Plan:** a lazy-loaded route (`client/src/app/risk/`, one line in `app.routes.ts`), standalone components + signals, existing UI idioms (`wa-dialog`, `wa-tag`, `sp-avatar`, theme vars).
- **Why:** the iframe was the disposable choice for embedding into a *foreign* host page. The client here is the same repo/SPA; a lazy route is equally disposable (delete directory + one route line) with none of the iframe's friction (double theming, message bridge, auth hand-off). The arch doc itself listed "lazy-loaded Angular route" as the alternative and predicted promoting to it — we just start there.

### 6. D1-vs-R2 open question (§14) → D1
- **Plan:** `risk_snapshots` as a D1 TEXT JSON blob per board (tens of KB). D1 is the only storage binding that exists; queryable if cross-board rollups ever matter. R2 only if snapshots ever balloon.

### 7. ACTIVE / IDLE / DORMANT / DEGRADED state machine (§6) → two cadences + degraded
- **Arch:** four-state per-board machine with `T`/`T2` knobs.
- **Plan:** viewed within 30 min → 5-min freshness; otherwise hourly (with jitter); `degraded_reason` for reauth/repeated failures. No separate DORMANT ("refresh on access only") because v1 has no on-demand refresh path (below) — the hourly floor plays that role at negligible cost at this scale.
- **Kept:** the demand-driven principle itself, the last-viewed signal set by the read route, refresh-cadence-as-config. The pricing-tier framing (§6) is dropped — no pricing exists.

### 8. Read-path push-refresh on view → not in v1
- **Arch (§6):** actively-viewed boards may push-refresh on view.
- **Plan:** the read route only records `last_viewed_at`; the next cron tick (≤3 min) picks the board up at active cadence. Reason: `route()` doesn't thread `ExecutionContext` today, and the worst case (first view of a never-refreshed board waits ≤3 min behind a `refreshing: true` state) is acceptable. Threading `ctx.waitUntil` is a contained follow-up if it annoys.

### 9. Cost model (§7) → mostly moot, one part kept
- Queue-ops meter: moot (no queue). CPU/subrequest reasoning: still correct and now load-bearing for the cron budget (~1,000 subrequests/invocation is the plan's actual ceiling). **Kept:** instrument per-org Jira-call counts from day one — it's also the graduation trigger for deviation #2.

## Scope / product deviations

### 10. Notifications (§9) → Phase 2, hooks reserved
- All of §9's product design is **kept unchanged** (hysteresis, transition-only firing, ticket-level alert with metric-level payload, per-human aggregation, quiet hours via the work clock, private-to-dev default). Deferred to Phase 2 per the arch's own build order ("build only after the snapshot write path is solid"). Phase 1 ships the marked seam in `refresh.ts` and the `risk_alert_state` DDL sketch; the table itself is created in `0011` when built (don't ship unused schema).

### 11. Risk admin config UI lives inside the feature, not the admin page
- Repo convention puts admin config in `admin.component.ts`; the plan puts it at `/risk/admin` inside `client/src/app/risk/`. Deliberate: deleting the feature must not leave dead panels in the admin page — deletability outranks UI-location consistency here. (Flip it if you prefer convention; costs one more existing-file touchpoint on deletion.)

### 12. `unassignedWip` composite weight dropped
- The userscript's `composite.weights` includes `unassignedWip` (L253), but its `compositeScore` iterates only registered `HEALTH` metrics — which never included `unassignedWip`. It's dead config. The `unassignedInProgress` **field** stays in the snapshot; the phantom weight does not. (Arch §10 lists the weights table without noticing this.)

### 13. dev-status PRs: probe-gated, expected to drop
- Arch §8 already flags this ("verify early… drop the PR feature rather than faking it"). The plan operationalizes it: one probe per org, result persisted in `dev_status_available`, `prs` omitted on failure, UI section absent. Not a deviation so much as a resolution of the arch's open question in the pessimistic direction pending the probe.

### 14. Per-org config instead of per-board config for cutoffs/composite/schedule
- The userscript configures one board; the arch doc is silent on config granularity. The plan scopes cutoffs/composite/work-schedule/fields to the **org** (`risk_board_config`, one row per `cloud_id`, boards as a JSON list). Rationale: cutoff tables describe a team's process; per-board overrides are a later refinement if an org's boards genuinely diverge.

### 15. Not ported (userscript features outside the arch's target design)
- Daily Scrum mode, Dev/PM view switch, viewer-side metric toggles/order (localStorage prefs), developer/tier filters, search, `retrospectivePoints`. See `1_replacement-plan.md` §5 — consistent with arch §11's "the triage list only needs the exception signal."

## §13 decision-table cross-check

Every "decisions already made" row from `0_arch.md` §13, disposition:

| Arch §13 decision | Disposition |
|---|---|
| Easy to delete (top constraint) | **Kept** — honored via directory isolation (deviation #1 changes the mechanism, not the property) |
| Separate Worker | **Changed** — deviation #1 |
| Naive monorepo, own directory, no Nx | **Kept** (already true of the repo) |
| Iframe frontend | **Changed** — deviation #5 |
| No shared kernel until 2nd consumer | **Kept** — logic in `worker/src/risk/logic/`, only wire types in `shared/` |
| Core is auth manager; risk board asks for tokens | **Kept in spirit** — deviation #3/#4 (JiraClient owns lifecycle; risk module consumes) |
| Service binding transport | **Changed** — deviation #4 |
| Token contract (core returns token; board makes own calls) | **Kept** — JiraClient mints/refreshes; risk code paces its own calls |
| Token caching (invocation-scoped, refresh on 401) | **Kept** — per-org client, invocation-scoped; 401-retry-once already in `JiraClient.get` |
| No shared DB across services | **Kept as module rule** — `risk_*` tables touched only by `risk/store.ts`; risk code never reads dao-owned tables directly (goes through `dao` for tokens) |
| Read vs write path split | **Kept** exactly |
| Notifications reuse core's notifiers + prefs | **Kept** — via `registry.resolve()` (Phase 2) |
| Alert firing: hysteresis, transition-only, ticket-level | **Kept** (Phase 2) |
| Alert payload: metric detail in ticket-level alert | **Kept** (Phase 2) |
| Alert tone/routing: private-to-dev default | **Kept** (Phase 2) |
| Paced Queue Consumer, no container | **Changed** — paced *cron* job, no container (deviation #2); no-container reasoning kept |
| One message per company, boards serial inside | **Kept as invariant, changed as mechanism** — per-org serialization + in-org pacing survive without the queue |
| Small batches, concurrency fans | **N/A** — no queue; budget+fairness replace it |
| Ack per message | **N/A** — per-board state rows give equivalent per-unit progress |
| Retry+backoff → DLQ → notify | **Changed mechanism** — failures counter → `degraded_reason` → UI surfacing |
| Snapshot writes: overwrite (idempotent) | **Kept** exactly |
| Refresh cadence: demand-driven | **Kept** (simplified — deviation #7) |
| "Done" = board's last column by position | **Kept** exactly |
| Timer basis: work-hours (NY schedule) | **Kept**, generalized to per-org config with the NY schedule as default |
| Pure logic ported unchanged | **Kept** — see port-mapping table in the plan |
| UI: risk-ranked triage list, detail on click | **Kept** exactly |
