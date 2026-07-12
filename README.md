# Story-point effort tracker

Personal/peer productivity tracker on top of Jira Cloud. Developers self-rate the
effort they put into each ticket (0/25/50/100%) as it moves through statuses; the
tool graphs **team-level** effort-claimed points against real Jira done points per
sprint. It is **not** a surveillance tool — see the privacy invariant below.

Single Cloudflare Worker deploy: the Worker serves the API **and** ships the built
Angular SPA as its static assets (same origin, no CORS, one `wrangler deploy`).

## Layout

```
shared/   types imported by both sides; depends on neither (enforced by eslint)
worker/   Cloudflare Worker — routes/, jira/, cron/, db/ (privacy enforced in db/dao.ts)
client/   Angular SPA (standalone components, signals); built into worker assets
```

## How it works

- **Detection is server-side polling, not webhooks** (webhooks need Jira admin).
  Cron every 3 min runs JQL `assignee = currentUser() AND status CHANGED AFTER "-10m"`
  with `expand=changelog`, per stored user token. The 10-min window > 3-min cron so a
  missed tick can't drop transitions.
- **Idempotency is by changelog entry id, not time** (`worker/src/jira/changelog.ts`,
  `shared/src/domain.ts:changelogIdGreater`, BigInt-safe). Overlapping windows are
  safe; each transition is counted exactly once. Cursor stored in `issue_state`.
- We prompt on **every** status transition; the human decides if it was worth points.
  Done-status transitions are *separately* recorded into the `done_events` series,
  bucketed into the sprint **whose window contains the changelog timestamp** (not the
  issue's current sprint — tickets reopen and move).
- **Story Points / Sprint custom fields are discovered, never hardcoded**
  (`worker/src/jira/fields.ts`); ambiguity is logged, not guessed.
- **OAuth 2.0 (3LO), all server-side.** Refresh tokens **rotate** — every refresh
  persists the new token and discards the old (`worker/src/jira/client.ts`). On
  `invalid_grant` the user is flagged `needsReauth`.

## Privacy invariant (load-bearing)

Enforced in `worker/src/db/dao.ts`, tested in `worker/test/privacy.test.ts`:

- The **only** method returning individual rating rows is `getRatingsForOwner(ownerId)`,
  which filters `WHERE rater_account_id = ?`. The personal route passes
  `req.user.accountId`; no path passes another account's id.
- Every aggregate method (`teamSeries`) groups by team and selects **sums only**,
  accepts **no** rater filter, and returns rows with **no account column**.

- A **minimum-team-size floor** (`MIN_TEAM_SIZE` in `shared/src/domain.ts`) keeps a team's
  aggregate from standing in for an individual's: a team with fewer than that many current
  members returns **no aggregate data at all** (empty series, `belowMinSize: true`), since on
  a two-person team `team_sum − your_number` reveals the other person. Enforced at the route
  boundary in `worker/src/routes/aggregates.ts` (and the team trend line in `ratings.ts`).

## Aggregation

Claimed points = **uncapped** Σ(`ratingFraction × storyPointsAtRating`) across raters
(a ticket can exceed 100% — an effort multiplier). The graph shows **two raw lines**
(claimed + done) plus a ratio toggle, with **rating-coverage** and
**claimed-per-active-rater** so a dip reads as real vs "people didn't rate".
Ratings snapshot `storyPointsAtRating` **and** `teamIdAtRating` so historical
re-aggregation stays honest when points/teams change later.

## Roles

`user` (any logged-in reachable account): own tracker + all team aggregates.
`admin`: + CRUD teams, effective-dated memberships, appoint/revoke admins, done-status
set. `BOOTSTRAP_ADMIN_ACCOUNT_ID` is a permanent recovery hatch. Cannot revoke the
last admin or self-revoke as sole admin (`worker/test/admin-guard.test.ts`).

## Billing (Stripe)

$5/month subscription with a **7-day free trial** that starts at a user's **first
login** — no card required during the trial. Once it lapses, unentitled users are
gated (`402 SUBSCRIPTION_REQUIRED`) until they subscribe. **Zero payment UI**:
Stripe **hosted Checkout** (redirect) to subscribe, the **Billing Portal** to
update the card / cancel / view invoices. No Stripe.js, no card fields (PCI
SAQ-A). The entitlement/gate wiring is load-bearing — see `worker/CLAUDE.md`.

- **The trial is app-side**, tracked by `account_id` in the `billing` table
  (`trial_started_at`) — not a Stripe trial. Existing/grandfathered users get a
  fresh trial lazily at their first gated request. Idempotent: re-login never
  resets it (no row = trial not started).
- **Entitled ⇔** inside the trial window **or** Stripe `subscription_status ∈
  {active, past_due}` (`past_due` hands the user Stripe's smart-retry window as a
  grace period). Only `BOOTSTRAP_ADMIN_ACCOUNT_ID` is exempt — appointing an admin
  is not a payment bypass.
- **Enforcement** is a single gate in `worker/src/index.ts`, above the
  sites/personal/admin routes. `/api/auth/*`, `/api/me`, and `/api/billing/*` stay
  **ungated** so a lapsed user can still see their state and pay. The client shows
  a trial banner (`trialing`) and swaps in a paywall for `<router-outlet/>` when
  `expired`.
- **The webhook is public** (`POST /api/billing/webhook`, above the auth gate —
  Stripe sends no cookie) and verifies its own signature; it handles three events
  (`checkout.session.completed`, `customer.subscription.{updated,deleted}`). The
  Checkout return also hits `/api/billing/confirm`, which applies the same
  idempotent upsert to close the webhook race on redirect.
- All Stripe SDK calls live in one file (`worker/src/billing/stripe.ts`);
  entitlement math is pure/tested in `worker/src/billing/entitlement.ts`. Tested in
  `worker/test/billing.test.ts` + `billing-webhook.test.ts`.

## Develop

```bash
npm install
npm test                       # vitest: changelog idempotency, privacy, dao, domain, billing
npm run typecheck              # worker + shared (strict)
cp .dev.vars.example .dev.vars # fill JIRA + VAPID + Stripe secrets

# D1
wrangler d1 create storypoint-tracker          # paste id into wrangler.toml
npm run db:migrate             # apply migrations/ to the local D1
npm run db:migrate:remote      # ...and to the remote (production) D1
# Schema changes: add a file with `npm run db:migrate:new <name>`, edit it, then
# re-run db:migrate. worker/src/db/schema.sql mirrors the full schema (it also
# backs the tests) — keep it in sync with the migrations.

npm run build:client           # ng build -> client/dist/client/browser
npm run dev                    # wrangler dev (serves API + SPA)
npm run deploy                 # build client + wrangler deploy
```

### Atlassian app setup

OAuth 2.0 (3LO) app, callback `https://<your-worker>/api/auth/callback`. Set
`JIRA_CLIENT_ID/SECRET` as secrets; VAPID keypair (base64url raw) as
`VAPID_PUBLIC_KEY/PRIVATE_KEY`.

**Scopes.** Each maps to an endpoint the poller actually calls (see
`worker/src/jira/`). Three are selectable in the developer console; `offline_access`
is not (see below).

| Scope | Where it's set | Grants | Used by |
| --- | --- | --- | --- |
| `read:jira-user` | console — Jira platform REST API (classic) | current user / display name (`GET /rest/api/3/myself`) | `jira/oauth.ts` (login), `cron/pd-report.ts` |
| `read:jira-work` | console — Jira platform REST API (classic) | read fields + JQL search (`GET /rest/api/3/field`, `GET /rest/api/3/search/jql`) | `jira/fields.ts`, `jira/search.ts` |
| `read:project:jira` | console — Jira platform REST API (granular) | required alongside the Software scope for Agile board reads (`GET /rest/agile/1.0/board`) | `cron/poller.ts` → `jira/search.ts` |
| `read:board-scope:jira-software` | console — Jira Software API (granular) | read boards + sprints (`GET /rest/agile/1.0/board`, `.../sprint`) | `cron/poller.ts` → `jira/search.ts` |
| `read:sprint:jira-software` | console — Jira Software API (granular) | read sprints (`.../board/{id}/sprint`) | `cron/poller.ts` → `jira/search.ts` |
| `offline_access` | **authorize URL only** (not the console) | rotating refresh tokens | `jira/client.ts` |

So in the developer console, under *Permissions*, add **two APIs** — "Jira platform
REST API" (tick `read:jira-user`, `read:jira-work`, `read:project:jira`) and "Jira
Software API" (tick `read:board-scope:jira-software` and `read:sprint:jira-software`).
You **won't find `offline_access` in either list** — it's a standard OAuth 2.0
scope, not a Jira permission. It's requested in the `/authorize` URL's `scope`
param, which the app already does via `OAUTH_SCOPES` in `worker/src/env.ts`. The
full string the app sends at consent:

`read:jira-user read:jira-work read:project:jira read:board-scope:jira-software read:sprint:jira-software offline_access`

Notes that bit us in practice:

- **The Agile API ignores classic scopes.** `read:jira-work` (classic) covers the
  platform calls (`/rest/api/3/...`) but does **not** authorize `/rest/agile/...`.
  The Agile endpoints require **granular** scopes — and crucially `GET
  /rest/agile/1.0/board` needs **both** `read:board-scope:jira-software` **and** the
  granular Jira *platform* scope `read:project:jira`. We originally requested only
  the `-software` granular scope, so boards 401'd even with everything ticked in the
  console (the token simply never carried `read:project:jira`).
- **The Jira Software API must be added to the app**, not just the scope ticked. If
  it isn't, `/rest/agile/1.0/board` returns **401** (boards/sprints silently stay
  empty — aggregates won't get a real "done" line). Note Atlassian *removes* an API
  from the app once its last scope is unticked, so editing/trimming other scopes can
  silently drop the Jira Software API — re-check it after any console scope change.
- **A token's scopes are frozen at consent.** After changing scopes you must
  **re-authorize** (log out and back in) — existing grants keep their old scopes.
  An `invalid_grant` flags the user `needsReauth`; a *scope* change does not, so
  re-auth is manual.

### Stripe setup

The app needs a recurring **Price**, an API key, and a **webhook signing secret**.
Prefer a **restricted key** (`rk_...`) with least privilege — write Checkout
Sessions + Billing Portal Sessions, read Subscriptions + Customers.

**Local (test mode):**

```bash
# 1. Stripe dashboard (test mode): create a Product + a $5/mo recurring Price.
#    Put the price_... into STRIPE_PRICE_ID and an rk_test_.../sk_test_ key into
#    STRIPE_SECRET_KEY in .dev.vars.
# 2. Forward webhooks to the local worker. This prints a whsec_... — put it into
#    STRIPE_WEBHOOK_SECRET in .dev.vars, then leave `stripe listen` running.
stripe listen --forward-to http://localhost:8787/api/billing/webhook \
  --events checkout.session.completed,customer.subscription.updated,customer.subscription.deleted

# 3. Run it. A fresh login shows a "7 days left" trial banner.
npm run db:migrate && npm run dev
# 4. Subscribe with test card 4242 4242 4242 4242 -> lands on /settings?billing=success.
# 5. To see the paywall, backdate the trial past 7 days:
wrangler d1 execute storypoint-tracker --local \
  --command "UPDATE billing SET trial_started_at='2000-01-01T00:00:00Z' WHERE account_id='<your-account-id>'"
```

**Production:** the price id is a **var**, the key and webhook secret are
**secrets**, and the webhook endpoint is registered in the dashboard (not
`stripe listen`).

```bash
wrangler secret put STRIPE_SECRET_KEY      # live rk_.../sk_...
wrangler secret put STRIPE_WEBHOOK_SECRET  # live whsec_ (from the dashboard endpoint below)
# Put the LIVE price_... into [vars] STRIPE_PRICE_ID in wrangler.toml.
# Dashboard -> Developers -> Webhooks -> add endpoint
#   https://<your-worker>/api/billing/webhook  with the 3 events above; copy its
#   signing secret into STRIPE_WEBHOOK_SECRET.
npm run db:migrate:remote && npm run deploy
```

## Open flags (decide against your Jira)

- **Done-event team attribution**: the raw `done_events` model carries no team, so a
  per-team done line needs one. We snapshot the polling assignee's team at done-time
  (`team_id_at_done`), mirroring the rating snapshot. Flagged because it's a refinement
  beyond the spec's data model.
## Multi-site

One Atlassian account's 3LO grant reaches many sites (cloudIds), so the rotating
refresh token is stored **once per account** (`oauth_tokens` keyed by `account_id`);
the reachable sites live in `user_sites`. The session carries the currently-selected
`cloudId`, switched via `POST /api/session/site` (guarded: must be a site the token
can reach). Aggregates/teams scope to the selected site; the nav shows a site picker
when there's more than one. The cron poller polls **every** site per account, and the
Jira client re-reads the shared token before refreshing so concurrent per-site clients
don't trip a false `invalid_grant` after a sibling rotates it. Tested in
`worker/test/multisite.test.ts`.
