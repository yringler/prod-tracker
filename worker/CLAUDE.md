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
dispatches HTTP, and its `scheduled` handler runs the poller + the GDPR
report-accounts job each tick.

## Directory map

- [`src/index.ts`](src/index.ts) — the only router. `fetch` (static vs `/api`
  split + `route()` dispatch table) and `scheduled` (cron: `runPoll` then
  `reportPersonalData`, each isolated so one can't abort the other).
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
  (team-grouped sums), `admin.ts` (teams, memberships, admins, config, fields),
  `settings.ts` (daily goal), `push.ts` (subscribe, VAPID key), `billing.ts`
  (entitlement gate, Checkout/Portal redirects, Checkout-confirm, Stripe webhook),
  `dev.ts` (local-only pending seeder, 404 in prod via `isDevEnv`).
- [`src/jira/`](src/jira/) — Jira integration: `client.ts` (per-account/-cloud
  authed client + token rotation), `oauth.ts` (3LO code/refresh, accessible
  resources, `/myself`), `fields.ts` (Story Points/Sprint field discovery),
  `changelog.ts` (pure transition parsing, idempotency, ownership), `search.ts`
  (JQL search + Agile boards/sprints).
- [`src/cron/`](src/cron/) — `poller.ts` (the poll: discover fields, refresh
  sprints, diff transitions, write pending/done, push) and `pd-report.ts` (GDPR
  report-accounts + erasure/refresh).
- [`src/db/`](src/db/) — `dao.ts` (the single data-access layer — **the privacy
  invariant lives here**), `driver.ts` (`D1Like` structural interface tests can
  back with SQLite), `schema.sql` (canonical schema; see Database below).
- [`src/billing/`](src/billing/) — Stripe billing. `stripe.ts` is the **only**
  payment-processing file (thin wrappers around the `stripe` SDK — Checkout,
  Portal, webhook verify; constructed with `createFetchHttpClient` +
  `createSubtleCryptoProvider` for Workers). `entitlement.ts` is **pure** trial /
  subscription-status logic (`deriveBilling`, unit-tested). Routes in
  `src/routes/billing.ts`.
- [`src/push/webpush.ts`](src/push/webpush.ts) — VAPID + RFC 8291 `aes128gcm` web
  push on WebCrypto (no Node `web-push` dependency).

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

### Billing entitlement (load-bearing wiring)
$5/mo Stripe subscription + 7-day app-side trial from first login. Rules the
router in [`src/index.ts`](src/index.ts) enforces — don't break them:
- **Webhook is PUBLIC** — `POST /api/billing/webhook` sits **above** the
  `authenticate()` gate (Stripe sends no cookie). It reads the **raw** body before
  any parse and verifies the signature (`billing/stripe.ts` `verifyWebhookEvent`,
  async `constructEventAsync`); a bad signature is a 400. It handles exactly three
  events (`checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`) and 200s on anything else. Correlation order:
  `client_reference_id` → subscription `metadata.account_id` →
  `getBillingByCustomerId`.
- **Gate placement** — the three authed billing routes (`checkout`, `portal`,
  `confirm`) plus `/api/auth/*` and `/api/me` are **above** the entitlement gate;
  everything else is below. The gate is `getEntitlement(ctx)` (which also lazily
  starts the trial — grandfathering) → `402 SUBSCRIPTION_REQUIRED` when
  `!entitled`. Never move `/api/me` or `/api/billing/*` below it, or a lapsed user
  can neither see their state nor pay.
- **Entitled ⇔** in the trial window OR `subscription_status ∈ {active, past_due}`.
  Only `BOOTSTRAP_ADMIN_ACCOUNT_ID` is exempt (mirrors `requireAdmin` — appointing
  an admin is not a payment bypass).
- **All Stripe SDK calls live in `billing/stripe.ts`.** Entitlement math is pure in
  `billing/entitlement.ts` (no I/O, unit-tested). DAO billing reads are
  account-scoped except `getBillingByCustomerId` (single-row webhook correlation).
  `billing` is included in the GDPR paths (`accountsForReport`, `eraseAccount`).

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
  `VAPID_SUBJECT`, `BOOTSTRAP_ADMIN_ACCOUNT_ID`, `STRIPE_PRICE_ID` (the
  recurring `price_...`).
- **Secrets** (`wrangler secret put`, locally in `.dev.vars`): `JIRA_CLIENT_ID`,
  `JIRA_CLIENT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `STRIPE_SECRET_KEY` (prefer a restricted `rk_...` key — least privilege:
  Checkout + Portal write, Subscriptions + Customers read), `STRIPE_WEBHOOK_SECRET`
  (the `whsec_...` from the dashboard endpoint / `stripe listen`).
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
- `billing.test.ts` — pure `deriveBilling` boundaries (trial day 6 vs 8,
  `active`/`past_due`/`canceled`/never-subscribed, exemption) + gate wiring
  (idempotent trial start, grandfathering, customer correlation, GDPR).
- `billing-webhook.test.ts` — real signature verify (signed with the SDK's
  `generateTestHeaderString`), the three events applied against the shim,
  customer-id correlation fallback, unknown-event no-op.
- `dao.test.ts`, `memberships.test.ts` (effective-dated, idempotent assignment),
  `multisite.test.ts` (one grant, many sites, site-switch guard),
  `org-members.test.ts` (org boundary), `settings.test.ts` (daily-goal validation;
  re-login never clobbers a saved goal).

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
