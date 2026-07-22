# worker/CLAUDE.md

Agent guidance for the Cloudflare Worker backend of **storypoint-tracker** (a
Jira-Cloud story-point effort tracker). Read the repo-root
[`../CLAUDE.md`](../CLAUDE.md) and [`../README.md`](../README.md) first — this file
cross-references them rather than repeating detection/polling, the privacy model,
OAuth, and field-discovery rationale.

## Orientation

The worker serves the JSON API under `/api/*` and ships the built Angular SPA as
static assets (everything else falls through to `env.ASSETS`). It's a plain
Cloudflare Worker (no Hono — a hand-rolled `route()` dispatcher), backed by
Cloudflare **D1** (SQLite) for storage and a **cron** trigger (`*/3 * * * *`) that
polls Jira. Entry point: [`src/index.ts`](src/index.ts) — its `fetch` handler
dispatches HTTP, and its `scheduled` handler runs the poller, the GDPR
report-accounts job, the notification-escalation job, and the risk-board refresh
each tick (each isolated).

## Directory map

- [`src/index.ts`](src/index.ts) — the only router. `fetch` (static vs `/api`
  split + `route()` dispatch table) and `scheduled` (cron: `runPoll`, then
  `reportPersonalData`, then `escalate`, then `refreshRiskBoards` — each in its own
  `try/catch` so one can't abort the others).
- [`src/http.ts`](src/http.ts) — `json`/`error` helpers (`error()` takes an optional
  4th `extra` for the structured half of `ApiError`, e.g. `issues`), cookie parse/set,
  `AuthedCtx`, `authenticate()` (sid cookie → session), `requireAdmin()`,
  `readJson()`.
- [`src/env.ts`](src/env.ts) — the `Env` binding interface + `OAUTH_SCOPE_LIST` /
  `OAUTH_SCOPES` (with the per-endpoint granular-scope table for the Agile API).
- [`src/pending.ts`](src/pending.ts) — pure "one JIRA = one rateable unit" policy:
  `groupPendingByIssue` (read transform + freshness) and `selectPushTransition`
  (push dedup). Server-only; unit-tested.
- [`src/log.ts`](src/log.ts) — structured one-JSON-line-per-call logging for
  Workers Logs; `log.child({...})` for per-tick `runId`; `errFields(e)` to
  normalize caught errors (never log raw `Error`).
- [`src/routes/`](src/routes/) — HTTP handlers, one file per area:
  `auth.ts` (OAuth start/callback/logout, `me`, sites, site-switch), `ratings.ts`
  (pending, submit, personal history, claimed-trends), `aggregates.ts`
  (team-grouped sums), `admin.ts` (teams, memberships, admins, config, fields,
  per-org notification-channel config),
  `settings.ts` (daily goal), `push.ts` (subscribe, VAPID key), `dev.ts`
  (local-only pending seeder, 404 in prod via `isDevEnv`), `notifications.ts`
  (list/begin/complete/status/unlink notification channels; `POST /test` fires a
  self-scoped test delivery to your own channels to verify the send path; setup submit
  routed to the resolved adapter).
- [`src/jira/`](src/jira/) — Jira integration: `client.ts` (per-account/-cloud
  authed client + token rotation + the scope-drift gate), `oauth.ts` (3LO
  code/refresh, accessible resources, `/myself`), `scopes.ts` (pure: read the
  access token's `scope` claim, diff it against `OAUTH_SCOPE_LIST`),
  `fields.ts` (Story Points/Sprint field discovery), `changelog.ts` (pure
  transition parsing, idempotency, ownership), `search.ts` (JQL search + Agile
  boards/sprints).
- [`src/cron/`](src/cron/) — `poller.ts` (the poll: discover fields, refresh
  sprints, diff transitions, write pending/done, push), `pd-report.ts` (GDPR
  report-accounts + erasure/refresh), and `escalate.ts` (the third isolated
  `scheduled()` job: re-delivers an un-acted `pending_ratings` prompt through a
  user's other linked channels once it survives `ESCALATION_DELAY_MS`, via the
  registry seam only — never touching an adapter directly).
- [`src/db/`](src/db/) — `dao.ts` (the single data-access layer — **the privacy
  invariant lives here**), `driver.ts` (`D1Like` structural interface tests can
  back with SQLite), `schema.sql` (canonical schema; see Database below).
- [`src/risk/`](src/risk/) — the **Sprint Risk Board**, a self-contained feature slice:
  `logic/` (pure port of the userscript's work-hours clock, timer reduction, segment
  builder, cutoff/scoring rules, HEALTH registry + the shipped default tables, and
  `preview.ts` — the admin impact preview's tier diff, which *calls* the scorer
  rather than reimplementing it),
  `jira.ts` (board configuration/issues/changelog/dev-status reads over a structural
  client), `refresh.ts` (the 4th isolated cron job — demand-driven eligibility,
  org-fair scheduling under a per-tick subrequest budget, overwrite-only snapshots),
  `store.ts` (**all `risk_*` SQL via `env.DB` — never `dao.ts`**, the adapter-store
  convention), `notify.ts` (one of two crossings of the notification seam:
  tells an org's admins when its boards stop/resume updating, via
  `registry.resolve()` only — never an adapter, never a vendor string; deduped per
  ORG by a claim-before-send CAS on `risk_board_config.degraded_notified_*`, and
  eslint-walled in `.eslintrc.cjs` alongside `routes/**` and `cron/**`; exports
  `deliverToAccount`, the per-account channel loop shared with alerts.ts),
  `alerts.ts` (the SECOND seam crossing — Phase-2 health nudges, see below) and
  `routes.ts` (two dispatchers: the authed read tier and the admin config tier).
  Wire types live in `@shared/risk`.
  - **Health-change nudges (Phase 2, `alerts.ts`).** When a ticket sits
    continuously at the `risk` tier for `FIRE_AFTER_RISK_WORK_HOURS` (8) **work**-hours,
    its assignee gets one private nudge through their linked channels (via
    `deliverToAccount`; registry seam only). Runs at the seam in `refreshBoard`
    (`processBoardAlerts`, before `overwriteSnapshot`, wrapped so it can never fail
    the board). Firing is **transition-only** with hysteresis: a pure state machine
    (`stepAlertState`) latches on the edge into `firing`, stays quiet, and re-arms
    only on a full return to `ok`/done — with a `REFIRE_COOLDOWN_WORK_HOURS` (16)
    gate before it can fire again. The accumulator is a stored **timestamp**
    (`risk_since`) measured by the org `WorkClock`, NOT a refresh counter, so a
    re-run recomputes the identical verdict (idempotent under overlapping polls).
    Ordering is **claim-before-send** (`store.claimAlertFiring`, the CAS twin of
    `claimDegradedNotice`): persist the latch, then deliver — lost, never duplicated.
    Quiet hours (`isWorkOpen` off the work clock) **hold** a fire, they don't drop it
    — the accumulator persists and the next work-open refresh re-derives and fires.
    Recipient key is `RiskTicket.assigneeAccountId` (populated by `mapIssue`;
    identity-mapped to `user_channels.account_id` — no join). Unassigned / unlinked /
    muted assignees consume the transition silently (claim with a NULL stamp, no
    per-refresh re-probe). Tables `risk_alert_state` (per ticket per board) and
    `risk_alert_prefs` (per-user mute opt-out) are touched only by `store.ts`; the
    two self-scoped prefs routes (`GET/PUT /api/risk/alerts/prefs`) live in
    `routes.ts` (`ctx.accountId`, never `dao.ts`).
  - **Scopes the slice needs beyond the poller's.** `fetchBoardMaps` reads
    `/board/{id}/configuration`, the one Agile call needing
    `read:board-scope.admin:jira-software` (a **separate** scope from
    `read:board-scope:jira-software`, not a superset) + `read:project:jira`, and
    necessary-but-not-sufficient — the refresher account also needs project-admin
    on the board. `pageBoardIssues` needs `read:issue-details:jira` (+
    `read:jql:jira` for the sprint-issues path). Do **not** "fix" a 401 here by
    rewriting the fetch layer onto JQL search: that fallback loses board-column
    fidelity, which every metric in `logic/` is built on. See README "Atlassian app
    setup" for the probed 401 map.
  - **Eligibility has brakes, not just cadence.** A board that can never succeed
    never gets a `last_refresh_at`, so cadence alone would elect it on every tick
    forever: `isEligible` also applies exponential backoff on consecutive
    `failures` (capped at `BACKOFF_CAP_MS`), and retries a `needs_reauth` board
    only once something that could actually fix it has happened: the org's config
    `updated_at` moves (an admin re-designated), **or** the refresher's grant looks
    usable again (`refresherUsable(dao, cfg)` — a token exists and `needs_reauth`
    is clear, which `dao.upsertUser` does on every login, so the commonest recovery
    self-heals with no human). `markDegraded` deliberately doesn't count a failure,
    so a re-elected board falls THROUGH to the normal failure backoff rather than
    short-circuiting. Ordering falls back to `last_attempt_at` so a failing board
    doesn't head the queue.
  - **Jira calls are counted per org** (a counting shim around the org's client)
    and logged per board / per org / per tick as `jiraCalls`; `BOARD_COST_ESTIMATE`
    is reconciled against the actual count so an over-spending board defers the
    rest of the tick. Those numbers are the documented graduation trigger for the
    Queue deviation (`artifacts/1_changes-from-arch.md` §2/§9) — keep them.
  - **GDPR:** `risk_*` lives outside `dao.ts`, so erasure reaches it through
    `store.riskEraseAccount(env, accountId)`, called from
    [`src/cron/pd-report.ts`](src/cron/pd-report.ts) right after `eraseAdapterData`
    — same "feature-owned tables must be reachable from the erasure seam" rule the
    notification adapters follow.
  - **Degradation is announced, not just badged.** `refreshRiskBoards` runs
    `notify.noticeDegradation` over its CONFIG loop — above the "nothing planned"
    early return — precisely because the orgs that most need announcing
    (`needs_reauth`, or a refresher erased by GDPR) are the ones that are never
    *eligible*, so anything hung off `refreshOrg` would never fire. One message per
    episode per org to `admins ∩ listOrgMembers(cloudId)` (capped, with
    `BOOTSTRAP_ADMIN_ACCOUNT_ID` as the fallback), re-sent on a reason change or
    every `DEGRADED_RENOTIFY_MS`, plus one when it recovers. `dao.ts` gains no
    method for this.
  - **Cutoff config validation and resolution are SHARED, deliberately.**
    `logic/scoring.ts` re-exports `resolveCutoff` / `sizeBucket` / `FIB_BUCKETS` /
    `HARD_FALLBACK` from `@shared/risk-cutoffs` (pure motion — `test/risk-scoring.test.ts`
    passes unchanged, which is the regression gate for the move), and `routes.ts`
    validates a `PUT`ed `cutoffs` with that module's `validateCutoffs`. The reason is
    drift: the admin editor has to answer "which rule wins for this column+size"
    interactively, so it runs the server's own function rather than a copy. The
    *scoring* path is unaffected and the client still never scores a ticket — see
    `shared/CLAUDE.md`. `validateCutoffs` returns structured `RiskConfigIssue`s that
    ride out on the new optional `ApiError.issues` (via `error()`'s 4th `extra`
    argument in `http.ts`); **errors block the save, warnings never do**. It is
    stricter than the old boolean validator: a half-filled rule, an off-ladder `size`
    and a duplicated `default` are now 400s, so a legacy blob containing one cannot be
    re-saved unchanged. Reads are unaffected (`store.ts` `parseJson` stays tolerant),
    and the editor auto-repairs all three on load with a visible callout.
  - **`GET /api/admin/risk/columns`** (admin tier) serves the editor's column
    vocabulary: per configured board `{columns, doneColumn, source}` plus
    `pointsFieldConfigured`. Resolution order is **stored snapshot first**
    (`store.listSnapshotColumns` — zero Jira calls, matching the read-path invariant);
    only a board configured but never refreshed falls back to one live `fetchBoardMaps`
    with the ADMIN'S token, and a failure there degrades that board to
    `source:'unavailable'` with a `probeError` rather than failing the endpoint.
    `doneColumn` comes from `logic/health.ts`'s `isDoneColumn`, not a re-derived "last
    element".
  - **Generic field metrics (the admin field-mapping list).** The four fixed
    custom-field slots (flagged/rejections/implementor/codeReviewer) are gone;
    `fields_json` now holds `RiskFieldConfigEntry[]` — each entry maps one Jira
    field, under an admin label, into its OWN metric in `RiskTicket.fieldMetrics`
    (keyed by field id; labels ride on `snapshot.fields`). `kind` is derived from
    Jira's `schema.type` (`number` → `count`, banded by per-entry warn/risk — the
    old hardcoded `REJ={2,4}` is dead; else → `flag`, binary) via the shared
    `kindForSchemaType`, resolved at pick time and STORED on the entry so scoring
    can't drift with discovery. Field weights live on the entry (`?? 1`; 0 =
    excluded), joining the composite as extra `{score, weight}` terms —
    `compositeScore` takes a term array now, and `RiskMetricId` is only the four
    built-ins. `blocked` is **link-only** (an open inward Blocks link); a flag
    field never ORs into it. Three degrade rules to keep: a fieldValues KEY absent
    (old snapshot / field added since) evaluates to band `'none'`/score null —
    never 0; a count key present-but-null reads 0 and bands ok; legacy `fields_json`
    OBJECT rows convert at read time (`store.fieldEntriesFromStored`: flagged →
    flag "Flagged", rejections → count "Rejections" 2/4, the two display-only user
    fields dropped) and re-save as the array — **no migration**, the column stayed
    TEXT. Entry validation is `@shared/risk-fields`'s `validateFieldEntries`, wired
    into `candidateConfigError` (same structured-issues 400 on PUT and preview).
    NOTE: a legacy composite blob still carrying a `rejections` weight 400s on a
    raw re-PUT; the client editor strips it on load, so editor saves are fine.
    `alerts.ts` drivers append firing field metrics under the admin's label.
  - **`GET /api/admin/risk/fields`** (admin tier) serves the Fields panel's whole
    vocabulary: **ALL of the site's Jira fields** (`listAllFields` — system fields
    included, since `labels`/`priority` are legitimate flag signals; each carries
    `schemaType` + the derived `kind`; the client text-filters the list — this
    replaced the old name-regex `listRiskFieldCandidates` buckets) **and** the
    site's status names (`listStatusCandidates`), for the In Progress status
    picker, plus the stored entries as `current`. This is the one admin endpoint
    that must hit Jira — neither list is in any snapshot — and it uses the ADMIN'S
    own token. Statuses are deduped BY NAME (Jira lists one per project; the
    config stores a name, and `logic/timers.ts` matches on the name) and carry
    Jira's `statusCategory` key, so the picker can offer `indeterminate` — Jira's
    own "in progress" — first. The status half **degrades to `[]`** rather than
    failing the endpoint: the field picker still works without it, and the client
    keeps a stored status selectable regardless.
  - **`POST /api/admin/risk/preview`** (admin tier) is the editor's IMPACT preview:
    "12 at risk / 9 warning / 40 healthy (was 6 / 8 / 47)", per board, before the
    save. Body is the candidate `{cutoffs, composite, schedule, fields}` with the
    same `null = inherit` semantics as the `PUT` — for cutoffs/composite/schedule
    that means the shipped default (which is why the handler substitutes
    `DEFAULT_CUTOFFS` explicitly: `resolveCutoff(null)` is the HARD FLOOR, not the
    defaults); for `fields` it means the STORED entries, since there is no code
    default to inherit. Four load-bearing properties:
    - **Zero Jira calls.** `RiskTicket` carries every field of `HealthInput`, so
      `store.listSnapshots` + `logic/preview.ts` re-score the STORED snapshots in
      place. Cheap enough to debounce on typing (the client does, 500 ms).
    - **No second scorer.** `logic/preview.ts` calls `evaluateTicket`/`tierCounts`
      verbatim; it exists to diff tiers, not to score. Do not inline scoring there
      — the preview's whole value is that it cannot drift from the cron.
    - **Same validation as the save.** Both paths go through
      `candidateConfigError()` (shared `validateCutoffs` + `validComposite` +
      `scheduleError`), so a config the preview accepts is a config that stores;
      an invalid one 400s with the identical structured `issues`.
    - **The schedule caveat is reported, never simulated.** The stored
      `idleHours`/`timeInColumnHours`/`cycleHours` were measured on the work clock
      of the snapshot's OWN schedule; a candidate schedule change can only be
      recomputed by a real refresh. `previewSnapshot` sets `scheduleStale` (via
      `sameSchedule`) and the UI says so in words. A board configured but never
      refreshed reports `status:'no-snapshot'` and is left out of the totals —
      not an error; `sampleMovers` is capped at `PREVIEW_SAMPLE_LIMIT` with
      `sampleTruncated` so the cap is never silent.
  - Deleting the feature = `rm -rf` the directory + the risk lines in
    `index.ts`/`schema.sql` + the `riskEraseAccount` call in `cron/pd-report.ts` +
    the `worker/src/risk/**` entry in the `.eslintrc.cjs` registry-seam override +
    `shared/src/risk.ts` / `shared/src/risk-cutoffs.ts` and their barrel lines +
    a DROP TABLE migration.
- [`src/push/webpush.ts`](src/push/webpush.ts) — VAPID + RFC 8291 `aes128gcm` web
  push on WebCrypto (no Node `web-push` dependency).
- [`src/notifications/`](src/notifications/) — the pluggable notification layer.
  `contract.ts` (the channel-neutral `NotifierAdapter` / `NotificationPayload` /
  `SetupStep` types the app codes against), `registry.ts` (`resolve(env, channel)` /
  `availableChannels()` — the only seam the app crosses to reach a channel), and
  `adapters/<channel>/` (`zulip/`, `email/`), each owning its vendor wire format
  (`render.ts` + `deliver.ts`), its persistence (`store.ts`, **`env.DB` only — never
  the app's `dao`**), and Zulip's inbound `webhook.ts`. See "Notification adapters"
  below.

## Key flows / where to make changes

- **Add an API route** — write the handler in the right `src/routes/*.ts`, then
  wire the path+method into the `route()` dispatch table in
  [`src/index.ts`](src/index.ts). Public routes go above the `authenticate()`
  gate; authenticated ones below it (they receive `AuthedCtx`); admin routes go
  under the `/api/admin/` block guarded by `requireAdmin()`.
- **Jira interaction** — everything goes through [`src/jira/client.ts`](src/jira/client.ts)
  (`client.get<T>(path)`), which handles bearer minting, refresh, and a
  401-retry. Add search/agile calls in `search.ts`, changelog parsing in
  `changelog.ts`, field logic in `fields.ts`, OAuth in `oauth.ts`.
- **The polling cron** — [`src/cron/poller.ts`](src/cron/poller.ts). `runPoll`
  iterates every stored grant × reachable site; `pollOneSite` does field
  discovery, sprint refresh, transition diffing, pending/done writes, and push.
- **DB access** — add methods to [`src/db/dao.ts`](src/db/dao.ts) only (no ad-hoc
  SQL in routes). Uphold the privacy invariant below.
- **Auth / OAuth** — [`src/jira/oauth.ts`](src/jira/oauth.ts) (flow),
  [`src/jira/client.ts`](src/jira/client.ts) (token rotation), and
  [`src/routes/auth.ts`](src/routes/auth.ts) (endpoints, session cookie, first-admin
  bootstrap).

## Load-bearing invariants — DO NOT BREAK

### Privacy invariant ("not a surveillance tool")
Enforced in [`src/db/dao.ts`](src/db/dao.ts); tested in
[`test/privacy.test.ts`](test/privacy.test.ts).
- The **only** method returning individual rating rows is `getRatingsForOwner(ownerAccountId)`,
  and it filters `WHERE rater_account_id = ?` in SQL. The route
  ([`routes/ratings.ts`](src/routes/ratings.ts) `myRatings`) passes `ctx.accountId`;
  no code path passes anyone else's id.
- Every aggregate/trend method (`teamSeries`, `teamClaimedByDay`,
  `personalClaimedByDay` is self-scoped) is **sums only, grouped by team, with no
  rater filter and no account column** in its result. `teamSeries` deliberately
  takes only `(cloudId, teamId, sinceIso)` — a date window, never a rater
  (`privacy.test.ts` asserts its arity == 3).
- A **`MIN_TEAM_SIZE` floor** (from `@shared/domain`) is enforced at the route
  boundary — [`routes/aggregates.ts`](src/routes/aggregates.ts) `buildTeamAggregate`
  returns an empty series + `belowMinSize: true` and never runs the query for a
  sub-floor team; [`routes/ratings.ts`](src/routes/ratings.ts) `claimedTrends`
  suppresses the team lines the same way. On a tiny team `team_sum − your_number`
  would unmask an individual.
- **Any new DB method returning per-account rows MUST take the owner id and
  filter on it**, and must be covered in `privacy.test.ts`. Erasure keeps
  aggregate value but replaces the accountId with an opaque `erased:*` id.
- CRON-ONLY exception: `accountsForReport` / `accountsDueForReport` return
  account-level data and must **never** be reachable from an HTTP route — they
  feed only [`src/cron/pd-report.ts`](src/cron/pd-report.ts).

### Idempotency by changelog entry id, not time
[`src/jira/changelog.ts`](src/jira/changelog.ts) + shared `changelogIdGreater`
(BigInt-safe comparison). `diffNewTransitions` emits only transitions strictly
newer than the stored cursor and advances the cursor past the max id *observed*
(even already-emitted ones), so the intentionally-wide, overlapping JQL poll
window (`searchChangedIssues`, 10 min vs 3 min cron) can't double-count. The
cursor is `issue_state.last_seen_changelog_id`; `done_events` also has a
`UNIQUE(cloud_id, changelog_id)` backstop. Tested in
[`test/changelog.test.ts`](test/changelog.test.ts).

### Story Points / Sprint custom fields are discovered, never hardcoded
[`src/jira/fields.ts`](src/jira/fields.ts). Their `customfield_*` ids vary per Jira
instance; `discoverFields` resolves them from `/rest/api/3/field` and caches them
in `config`. If **>1** plausible candidate exists it returns `null` + populates
`ambiguous` — the poller logs it (never guesses), and an admin resolves it via the
field picker (`routes/admin.ts` `listFields`/`setFields`,
`listFieldCandidates`).

### OAuth refresh tokens rotate
[`src/jira/client.ts`](src/jira/client.ts). Every refresh persists the new refresh
token via `dao.upsertToken` and discards the old one; before refreshing it
re-reads the row in case a sibling client (same account, another site) already
rotated it. On `invalid_grant` it sets `needs_reauth` and throws
`ReauthRequiredError` (the poller then skips that grant's sites). One grant per
account (keyed by `account_id`), shared across all reachable sites.

### Scope drift is detected, not assumed
[`src/jira/scopes.ts`](src/jira/scopes.ts) + the `assertScopes` gate in
[`src/jira/client.ts`](src/jira/client.ts); tested in
[`test/scopes.test.ts`](test/scopes.test.ts). **Adding a scope to
`OAUTH_SCOPE_LIST` does not invalidate existing grants** — old refresh tokens keep
minting access tokens carrying the OLD scope set, so there is no `invalid_grant`
and the newly-scoped calls just 401 forever. So `client.accessToken()` — the single
choke point every bearer passes through — decodes the access token's `scope` claim
(Atlassian's tokens are JWTs) and, when a required scope is absent, sets
`needs_reauth` and throws **`ScopeDriftError`, a SUBCLASS of
`ReauthRequiredError`**. That subclassing is the whole design: the poller's
per-account skip, `pd-report`'s bearer loop, and `risk/refresh.ts`'
`markDegraded(..., 'needs_reauth')` (and the admin notice hanging off it in
`risk/notify.ts`) all handle it unchanged — **do not add a parallel notification
path**. Two rules when touching this: it **fails open** on any token it can't parse
(never lock out a working user), and the verdict is **memoized per token string**
so the DB write happens once per token, not once per Jira call. Changing
`OAUTH_SCOPE_LIST` therefore forces every existing user through one re-authorize —
say so in the release notes, and tick the scope on the app in the Atlassian
developer console first (listing it in code only changes the consent URL).

### Admin guardrails
[`src/routes/admin.ts`](src/routes/admin.ts) `revokeAdmin`; tested in
[`test/admin-guard.test.ts`](test/admin-guard.test.ts). Cannot revoke the last
remaining admin (`409 LAST_ADMIN`) or self-revoke as the sole admin
(`409 SOLE_ADMIN_SELF`). `BOOTSTRAP_ADMIN_ACCOUNT_ID` (env var) is a permanent
recovery hatch — always treated as admin (`http.requireAdmin`) and bootstraps the
first admin on its first login (`routes/auth.ts`).

### Notification adapters (the app never composes a vendor string)
The app owns *routing* and the neutral `NotificationPayload`; each adapter owns its
vendor format and its own tables. Enforced by eslint walls (`.eslintrc.cjs`):
`notifications/adapters/**` may not import `routes/**`, `cron/**`, `db/dao*`,
`**/registry`, `**/index`, or a **sibling** adapter; `routes/**` and `cron/**` may
not import `notifications/adapters/**`. The only crossing points are
`registry.resolve()` and the neutral `dao.registerChannel` callback passed into the
webhook.
- **Data split.** App-owned rows (`user_channels`, self-scoped) live in `dao.ts` and
  are reached by erasure/report (`eraseAccount`, `accountsForReport`). Adapter-owned
  rows (`zulip_*`, `email_links`, `email_org_config`) stay out of `dao.ts` entirely,
  are touched only by the adapter's `store.ts` via `env.DB`, and are wiped through
  the registry `unlink` seam (`pd-report.ts:eraseAdapterData`) — keep any new
  adapter's tables reachable from that seam or GDPR erasure will silently miss them.
- **Opt-in vs identity (they are orthogonal).** `user_channels.enabled` (added 0013)
  is the user's *do I want this?*; the adapter's own link row is *who am I here?*.
  `dao.getUserChannels` filters `AND enabled = 1` and is the **single** enforcement
  point — it covers `cron/escalate.ts`, the test-notification route, and
  `risk/notify.ts`'s `deliverToAccount` (hence `risk/alerts.ts`) at once. The
  settings list must therefore use `dao.listChannelPrefs` (unfiltered, self-scoped)
  instead. `registerChannel`'s conflict clause deliberately does NOT touch
  `enabled`, so re-linking can't silently re-enable someone who opted out;
  `PUT /api/notifications/:channel/enabled` (`routes/notifications.ts`
  `setChannelEnabled`) is the toggle, and `DELETE /api/notifications/:channel` now
  means *forget my address*, not *mute*.
- **Adding a channel.** Implement `NotifierAdapter` under `adapters/<channel>/`,
  register it in `registry.ts`; do **not** add a new `SetupStep` kind or touch
  `cron/escalate.ts` (the email adapter proved the contract by needing neither).
- **Availability gating.** An adapter reports whether it can deliver **for an org**
  via the optional `isConfigured(orgId)` (contract.ts). BOTH shipped adapters are
  now per-org DB config: zulip → a `zulip_org_config` row; email → an
  `email_org_config` row, **falling back to the legacy `EMAIL_API_KEY`+`EMAIL_FROM`
  env pair** when the org has none (back-compat; those vars are deprecated).
  `routes/notifications.ts` passes `ctx.cloudId`, hides unconfigured channels from
  the list, and 404s their setup routes, so a channel that can't deliver is never
  advertised.
- **Delivery is handed an org.** `DeliverRequest.orgId` says which org's
  provisioning to send under; every call site already knew it (`p.cloudId`,
  `ctx.cloudId`, `cfg.cloudId`). `req.orgId` is **authoritative and there is no
  fall-through**: an org with no provisioning simply fails to deliver, because org A
  un-provisioning must never route an org-A reminder through org B's credentials.
  Only a link with no org at all (pre-0008 NULL, reachable only when the caller has no
  org either) falls back to the link row's own `cloud_id` / the sole-config path.
- **Per-org adapter config (write-only secrets).** Zulip's credentials are
  admin-entered per org (`cloud_id`), not env config: the descriptor advertises
  `requestedFields` (shared), the admin UI posts them to
  `PUT /api/admin/notifications/:channel/config` (`routes/admin.ts`
  `listChannelConfigs`/`configureChannel`, inside the `requireAdmin` block), and the
  route forwards to the adapter's optional `configureOrg(orgId, fields, by)` — which
  live-verifies against the vendor, then encrypts `{site,botEmail,apiKey}` with
  AES-256-GCM under the `SECRETS_KEY` secret ([`src/notifications/secretbox.ts`](src/notifications/secretbox.ts) —
  deliberately outside `adapters/` so both adapters and routes may import it) into
  `zulip_org_config`. The **webhook token is stored only as a SHA-256 hash**: the
  inbound webhook's hash lookup both authenticates the request and resolves the org,
  which is then stamped onto `zulip_links.cloud_id` at link time; `deliver()` loads
  that org's creds (a NULL-org pre-0008 link falls back to the sole config row).
  The same shape now covers **email**: `configureEmailOrg` live-verifies the key
  against the transport, seals `{apiKey,fromAddress}` into `email_org_config`, and
  additionally stores `from_address` **in the clear** — it is the one non-secret
  provisioning value the admin UI echoes back. Adapters may also implement
  `unconfigureOrg(orgId)` (`DELETE /api/admin/notifications/:channel/config`) and
  `orgConfigSummary(orgId)`, whose `summary` is an **explicit per-adapter allow-list
  of non-secret fields** (zulip → `site`, email → `fromAddress`). Everything else
  stays write-only: `secrets_enc`, `apiKey` and `webhook_token_hash` never flow back
  to any client.

## Database

- **Schema changes go through [`../migrations/`](../migrations/)** (see
  [`../migrations/CLAUDE.md`](../migrations/CLAUDE.md)) — versioned, idempotent
  `NNNN_*.sql` files applied with `wrangler d1 migrations apply` (see the
  `db:migrate*` scripts in the root `package.json`). Wrangler tracks applied
  files in a `d1_migrations` table; `migrations_dir` is set in
  [`../wrangler.toml`](../wrangler.toml). Do **not** hand-edit the remote schema.
- [`src/db/schema.sql`](src/db/schema.sql) is the **canonical consolidated
  schema** and is what the tests load ([`test/support/sqlite-d1.ts`](test/support/sqlite-d1.ts)
  reads it to back `D1Like` with better-sqlite3). When you add a migration, keep
  `schema.sql` in sync (it carries `-- keep in sync with migrations/000N_*.sql`
  notes for the incremental columns) — otherwise tests and production drift.
- [`src/db/dao.ts`](src/db/dao.ts) is the sole SQL layer; [`src/db/driver.ts`](src/db/driver.ts)
  defines the minimal `D1Like` interface that keeps the DAO test-backable.

## Env / secrets

Bindings/vars/secrets are typed in [`src/env.ts`](src/env.ts) and configured in
[`../wrangler.toml`](../wrangler.toml); copy [`../.dev.vars.example`](../.dev.vars.example)
to `../.dev.vars` for `wrangler dev`.
- **Bindings**: `DB` (D1), `ASSETS` (static SPA).
- **Vars** (`[vars]` in wrangler.toml): `APP_ORIGIN`, `OAUTH_REDIRECT_PATH`,
  `VAPID_SUBJECT`, `BOOTSTRAP_ADMIN_ACCOUNT_ID`, `EMAIL_FROM` (**legacy fallback**;
  email provisioning moved to Admin → Notification channels in 0013).
- **Secrets** (`wrangler secret put`, locally in `.dev.vars`): `JIRA_CLIENT_ID`,
  `JIRA_CLIENT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `EMAIL_API_KEY`
  (**legacy fallback** — prefer Admin → Notification channels, as with `EMAIL_FROM`),
  and `SECRETS_KEY` (base64 of 32 random bytes — the AES-256-GCM master key for
  per-org adapter secrets stored in D1; Zulip credentials are admin-entered in the
  app, not env config).
- `isDevEnv` keys off `APP_ORIGIN` starting with `http://localhost` to gate
  dev-only routes.

## Testing

Vitest, in [`test/`](test/); run from the **repo root** with `npm test` (also
runs as part of the wrangler `[build]` command before every deploy). DB tests use
[`test/support/sqlite-d1.ts`](test/support/sqlite-d1.ts) to execute the DAO's real
SQL against better-sqlite3.
- `privacy.test.ts` — the privacy invariant end-to-end (owner-scoped reads,
  sums-only aggregates, `MIN_TEAM_SIZE` floor, self-scoped trends).
- `admin-guard.test.ts` — last-admin / sole-self-revoke guards.
- `changelog.test.ts` — `extractStatusTransitions`, `diffNewTransitions`
  idempotency, `transitionOwnership`.
- `pending.test.ts` — pure `groupPendingByIssue` + `selectPushTransition` policy.
- `ratings.test.ts` — pending bundling + a single claim clearing all of an
  issue's transitions.
- `pd-report.test.ts` — GDPR report-accounts cadence + erasure/refresh (stubbed
  fetch).
- `dao.test.ts`, `memberships.test.ts` (effective-dated, idempotent assignment),
  `multisite.test.ts` (one grant, many sites, site-switch guard),
  `org-members.test.ts` (org boundary), `settings.test.ts` (daily-goal validation;
  re-login never clobbers a saved goal).
- `zulip-adapter.test.ts` / `zulip-webhook.test.ts` — Zulip deliver wire shape,
  per-org deliver routing (incl. the NULL-org sole-config fallback),
  status/unlink/setup, and the inbound webhook (token-hash → org resolution,
  `direct_message` guard, rate limit, atomic single-use TTL'd code redemption).
- `zulip-config.test.ts` — `configureZulipOrg`: validation, live credential verify,
  encrypt-at-rest persistence, upsert, cross-org duplicate-token guard.
- `secretbox.test.ts` — seal/open roundtrip, tamper/wrong-key rejection, sha256Hex.
- `admin-notifications.test.ts` — admin channel-config list (write-only) + configure
  route (ok / adapter error as 400 / 404).
- `email-adapter.test.ts` — email deliver + link store.
- `notifications-routes.test.ts` — list/begin/complete/status/unlink route wiring
  (incl. per-org hiding of an unconfigured zulip), plus the `POST /test` self-serve
  delivery check (delivered / not_linked / no-channels).
- `risk-workhours.test.ts` / `risk-timers.test.ts` / `risk-segments.test.ts` /
  `risk-scoring.test.ts` — the risk board's pure logic (DST-safe work clock, the
  Done-is-a-pause timers, segment merge, cutoff specificity + composite goldens).
- `risk-preview.test.ts` — the impact preview: known before/after counts for a known
  cutoffs change (both directions), the sample cap + `sampleTruncated`, `cutoffs:null`
  previewing the shipped DEFAULTS (not `HARD_FALLBACK`), the schedule-staleness flag,
  a no-snapshot board degrading out of the totals, org isolation, the save path's
  validation errors, the admin guard, and — asserted by making `globalThis.fetch`
  throw — ZERO Jira calls.
- `risk-store.test.ts` / `risk-refresh.test.ts` / `risk-routes.test.ts` — risk board
  persistence (incl. `listSnapshots` / `listSnapshotColumns` org scoping +
  corrupt-JSON degradation),
  the write path (snapshot golden, idempotency, eligibility, budgeted org-fair
  scheduling, degraded paths incl. the needs_reauth self-heal), and the read/admin
  routes (incl. the structured `issues` on a 400, and that
  `GET /api/admin/risk/columns` prefers the stored snapshot with zero Jira calls).
- `risk-cutoff-editor.test.ts` — the load-bearing equivalence proof for the admin
  editor's two load-time transforms: over every (column × points) pair the shipped
  tables can distinguish, `collapseRedundantRules` (64 idle rules -> 7) and the
  `toEditorModel`/`fromEditorModel` round-trip change **no** resolution.
- `risk-alerts.test.ts` — Phase-2 health nudges: the pure hysteresis policy
  (threshold, weekend-zero accrual, mid-vs-ok, recovered cooldown, GC, re-run
  safety, drivers/hash/format) + the diff step through `processBoardAlerts`
  (fire-once-on-edge, per-recipient aggregation, quiet-hours hold, the claim CAS,
  unreachable/muted consume-and-latch, board-departure cleanup, alert-pass D1
  failure not failing the board, deploy-day storm guard).
- `risk-notify.test.ts` — the degraded/recovery notice: per-org collapse, the
  claim-before-send CAS (idempotent re-run), renotify cadence + reason change,
  recipient scoping (org admins only, bootstrap fallback, unreachable org still
  claimed), and the erased-refresher tick that no eligibility path would reach.
- `escalate.test.ts` — deliver-once, idempotent re-run, no-channel mark, stale-never,
  fresh-not-yet.
- `scopes.test.ts` — scope drift: the required-scope list, JWT `scope`-claim
  parsing (string/array/opaque/malformed), the missing-scope diff for a pre-fix
  grant, and the client gate (flags `needs_reauth` before spending a subrequest,
  is a `ReauthRequiredError`, writes once per token, fails open).

## Conventions

- Follow repo-wide conventions in [`../CLAUDE.md`](../CLAUDE.md): use **date-fns**
  for date math and wrap timezone-sensitive inputs in `UTCDate` from
  `@date-fns/utc` (see `aggregates.ts` `aggregateSince` and shared
  [`../shared/src/domain.ts`](../shared/src/domain.ts) `weekStartOf`). All DB
  timestamps are UTC ISO strings.
- Logging: use `log` / `log.child` / `errFields` from [`src/log.ts`](src/log.ts)
  (one structured JSON line per call) — never `console.log` raw objects or bare
  `Error`s.
- Error handling: return via `error(status, message, code?)` from `http.ts`;
  unhandled throws in `route()` are caught in `index.ts` and become a generic
  `500` (details logged, not leaked).
- Shared types/domain logic live in `@shared/*` ([`../shared/CLAUDE.md`](../shared/CLAUDE.md)) —
  import contracts/domain from there rather than redefining.

---
Keep this file up to date when the worker's structure or invariants change.
