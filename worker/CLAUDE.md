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
report-accounts job, and the notification-escalation job each tick (each
isolated).

## Directory map

- [`src/index.ts`](src/index.ts) — the only router. `fetch` (static vs `/api`
  split + `route()` dispatch table) and `scheduled` (cron: `runPoll`, then
  `reportPersonalData`, then `escalate` — each in its own `try/catch` so one
  can't abort the others).
- [`src/http.ts`](src/http.ts) — `json`/`error` helpers, cookie parse/set,
  `AuthedCtx`, `authenticate()` (sid cookie → session), `requireAdmin()`,
  `readJson()`.
- [`src/env.ts`](src/env.ts) — the `Env` binding interface + `OAUTH_SCOPES` (with
  the granular-scope rationale for the Agile API).
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
  authed client + token rotation), `oauth.ts` (3LO code/refresh, accessible
  resources, `/myself`), `fields.ts` (Story Points/Sprint field discovery),
  `changelog.ts` (pure transition parsing, idempotency, ownership), `search.ts`
  (JQL search + Agile boards/sprints).
- [`src/cron/`](src/cron/) — `poller.ts` (the poll: discover fields, refresh
  sprints, diff transitions, write pending/done, push), `pd-report.ts` (GDPR
  report-accounts + erasure/refresh), and `escalate.ts` (the third isolated
  `scheduled()` job: re-delivers an un-acted `pending_ratings` prompt through a
  user's other linked channels once it survives `ESCALATION_DELAY_MS`, via the
  registry seam only — never touching an adapter directly).
- [`src/db/`](src/db/) — `dao.ts` (the single data-access layer — **the privacy
  invariant lives here**), `driver.ts` (`D1Like` structural interface tests can
  back with SQLite), `schema.sql` (canonical schema; see Database below).
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
  rows (`zulip_*`, `email_links`) stay out of `dao.ts` entirely, are touched only by
  the adapter's `store.ts` via `env.DB`, and are wiped through the registry `unlink`
  seam (`pd-report.ts:eraseAdapterData`) — keep any new adapter's tables reachable
  from that seam or GDPR erasure will silently miss them.
- **Adding a channel.** Implement `NotifierAdapter` under `adapters/<channel>/`,
  register it in `registry.ts`; do **not** add a new `SetupStep` kind or touch
  `cron/escalate.ts` (the email adapter proved the contract by needing neither).
- **Availability gating.** An adapter reports whether it can deliver **for an org**
  via the optional `isConfigured(orgId)` (contract.ts; env-based adapters ignore the
  orgId — email → `EMAIL_API_KEY`+`EMAIL_FROM`; zulip → a `zulip_org_config` row for
  that org). `routes/notifications.ts` passes `ctx.cloudId`, hides unconfigured
  channels from the list, and 404s their setup routes, so a channel that can't
  deliver is never advertised.
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
  Stored values never flow back to any client — the admin list returns only a
  `configured` boolean.

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
  `VAPID_SUBJECT`, `BOOTSTRAP_ADMIN_ACCOUNT_ID`.
- **Secrets** (`wrangler secret put`, locally in `.dev.vars`): `JIRA_CLIENT_ID`,
  `JIRA_CLIENT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `EMAIL_API_KEY`,
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
- `escalate.test.ts` — deliver-once, idempotent re-run, no-channel mark, stale-never,
  fresh-not-yet.

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
