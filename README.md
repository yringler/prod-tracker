# Story-point effort tracker

A private coach for your own effort, on top of Jira Cloud. As your Jira tickets move
through statuses, take a few seconds to self-rate the effort you put into each one
(0/25/50/100%). Then look back and see **how much you've done** — today, this week,
this month — and, from that same history, **how much you can do**. It also graphs
anonymized **team-level** claimed effort against real Jira done points per sprint. It
is **not** a surveillance tool — see the privacy invariant below.

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

## Develop

```bash
npm install
npm test                       # vitest: changelog idempotency, privacy, dao, domain
npm run typecheck              # worker + shared (strict)
cp .dev.vars.example .dev.vars # fill JIRA + VAPID secrets

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

**Scopes.** Each maps to an endpoint the app actually calls (see `worker/src/jira/`
and `worker/src/risk/jira.ts`). All but `offline_access` are selectable in the
developer console.

| Scope | Where it's set | Grants | Used by |
| --- | --- | --- | --- |
| `read:jira-user` | console — Jira platform REST API (classic) | current user / display name (`GET /rest/api/3/myself`) | `jira/oauth.ts` (login), `cron/pd-report.ts` |
| `read:jira-work` | console — Jira platform REST API (classic) | read fields, statuses, changelogs + JQL search (`GET /rest/api/3/field`, `/status`, `/issue/{id}/changelog`, `/search/jql`) | `jira/fields.ts`, `jira/search.ts`, `risk/jira.ts` |
| `read:project:jira` | console — Jira platform REST API (granular) | required alongside the Software scope for Agile board reads, and again for board *configuration* | `cron/poller.ts` → `jira/search.ts`, `risk/jira.ts` |
| `read:issue-details:jira` | console — Jira platform REST API (granular) | required alongside the Software scopes for every Agile endpoint that returns issues | `risk/jira.ts` (`pageBoardIssues`) |
| `read:jql:jira` | console — Jira platform REST API (granular) | required for the Agile sprint-issues endpoint | `risk/jira.ts` (`pageBoardIssues`) |
| `read:board-scope:jira-software` | console — Jira Software API (granular) | list boards + read a board (`GET /rest/agile/1.0/board`, `.../board/{id}`) | `cron/poller.ts` → `jira/search.ts`, `risk/jira.ts` |
| `read:board-scope.admin:jira-software` | console — Jira Software API (granular) | read a board's **column configuration** (`.../board/{id}/configuration`) | `risk/jira.ts` (`fetchBoardMaps`) |
| `read:sprint:jira-software` | console — Jira Software API (granular) | read sprints + their issues (`.../board/{id}/sprint`, `.../sprint/{sid}/issue`) | `cron/poller.ts` → `jira/search.ts`, `risk/jira.ts` |
| `offline_access` | **authorize URL only** (not the console) | rotating refresh tokens | `jira/client.ts` |

So in the developer console, under *Permissions*, add **two APIs** — "Jira platform
REST API" (tick `read:jira-user`, `read:jira-work`, `read:project:jira`,
`read:issue-details:jira`, `read:jql:jira`) and "Jira Software API" (tick
`read:board-scope:jira-software`, `read:board-scope.admin:jira-software` and
`read:sprint:jira-software`). You **won't find `offline_access` in either list** —
it's a standard OAuth 2.0 scope, not a Jira permission. It's requested in the
`/authorize` URL's `scope` param, which the app already does via `OAUTH_SCOPES` in
`worker/src/env.ts` — the single source of the string sent at consent.

Notes that bit us in practice:

- **Jira Software supports no classic scopes at all.** Not "prefers granular" —
  *none*. `read:jira-work` authorizes the platform calls (`/rest/api/3/...`) and
  grants literally nothing on `/rest/agile/...`. Worse, the platform-*granular*
  scopes that a Software operation additionally requires must appear **literally**
  in the request even when the classic `read:jira-work` is already present:
  `read:jira-work` does not stand in for `read:issue-details:jira`. We originally
  requested only the `-software` granular scopes and boards 401'd with everything
  ticked in the console, because the token never carried `read:project:jira`.
- **`.admin` is a different scope, not a bigger one.**
  `read:board-scope.admin:jira-software` is not a superset of
  `read:board-scope:jira-software` — nothing about holding one implies the other,
  and the Sprint Risk Board needs both (the board read uses the base scope, the
  column-configuration read uses the `.admin` one). And the scope is
  *necessary, not sufficient*: Jira's own permissions still apply on top, so the
  account designated as a board's refresher also needs project-admin rights on that
  board or `/configuration` 401s with every scope in place.
- **The empirical 401 map.** Probing a live site with a token granted exactly
  `offline_access read:jira-user read:jira-work read:board-scope:jira-software
  read:project:jira read:sprint:jira-software` gave a clean split. **200:**
  `/rest/agile/1.0/board` (list), `/rest/agile/1.0/board/{id}/sprint`,
  `/rest/api/3/status`, `/rest/api/3/field`, `/rest/api/3/issue/{id}/changelog`,
  `/rest/api/3/search/jql` (bounded queries only). **401 "Unauthorized; scope does
  not match":** `/rest/agile/1.0/board/{id}`, `.../board/{id}/configuration`,
  `.../board/{id}/issue`, `.../board/{id}/backlog`,
  `.../board/{id}/sprint/{sid}/issue`, `/rest/agile/1.0/sprint/{sid}/issue`, and
  `/rest/dev-status/latest/issue/summary`. Note how *listing* boards and sprints
  works while *reading* one doesn't — the difference is the issue-returning
  endpoints needing `read:issue-details:jira`. Also note dev-status appears in
  neither of Atlassian's OpenAPI specs: it's undocumented for 3LO, which is why the
  risk board probes it once per org and permanently drops PRs when it fails.
- **Ticking a scope in code is not enough — it must be enabled on the app.** Adding
  a scope to `OAUTH_SCOPES` only changes the consent URL; if the app in the
  developer console doesn't offer it, consent fails or comes back short. Note
  Atlassian *removes* an API from the app once its last scope is unticked, so
  editing/trimming other scopes can silently drop the Jira Software API — re-check
  it after any console scope change.
- **A token's scopes are frozen at consent, and a scope change is silent.** Adding
  a scope does **not** invalidate existing grants: old refresh tokens keep working
  and keep minting access tokens carrying the *old* scope set, so there's no
  `invalid_grant` to notice and the new calls simply 401 forever. The app now
  detects this itself — `worker/src/jira/scopes.ts` reads the `scope` claim out of
  the access token (Atlassian's are JWTs) and compares it against what the build
  requires; a short grant is flagged `needsReauth` and raises a `ScopeDriftError`,
  which is a subclass of `ReauthRequiredError` so the poller, the GDPR job and the
  risk-board refresher all handle it through paths that already existed. Users see
  the "Re-connect Jira" banner; risk-board admins get the degraded notice. The check
  fails **open** on any token it can't parse, so it can never lock out a working
  user.

> **Deploying a scope change:** after the release that added
> `read:board-scope.admin:jira-software`, `read:issue-details:jira` and
> `read:jql:jira`, **every existing user must re-authorize once** (log out and back
> in, or follow the "Re-connect Jira" banner). Tick the three new scopes on the app
> in the developer console *before* deploying, or the re-consent will hand back the
> same short grant.

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

## Notification escalation & channels

We already web-push a reminder when a ticket transitions and you haven't rated the
effort. **Escalation** re-delivers that same reminder through another channel if you
*still* haven't acted after `ESCALATION_DELAY_MS` (10 min, `shared/src/domain.ts`).
The 3-min cron's third job (`worker/src/cron/escalate.ts`) scans `pending_ratings`
rows older than the window with `escalated_at IS NULL`, builds a **channel-neutral**
payload, and walks your linked channels until one accepts it — then marks the row so
it escalates **at most once**.

Channels are **pluggable adapters** (`worker/src/notifications/`), hard-isolated from
the app by eslint import walls: the app owns routing + the neutral payload and **never
composes a vendor string**; each adapter owns its vendor wire format, its own tables
(`env.DB`, never `dao`), and its own link flow. Two ship today — **Zulip** and
**email** — and the settings UI renders each adapter's self-described setup steps
generically. See `worker/CLAUDE.md` → "Notification adapters". You connect a channel
in the app under **Settings → Notifications**.

### Zulip bot & webhook setup

**One Outgoing-webhook bot does everything** — it *sends* your reminders (via its API
key) and *receives* the `/link` DM (via the webhook). Create it in Zulip → *gear* →
*Personal* (or *Organization*) *settings* → **Bots** → *Add a new bot* → bot type
**Outgoing webhook**. It needs **no org-admin** — the link flow stores your numeric
Zulip `user_id` (captured from the DM you send), never your email, so it works
regardless of `email_address_visibility`.

Set the bot's **Endpoint URL** (a.k.a. payload URL) to:

```
https://<your-worker-domain>/api/notifications/zulip/webhook
```

Then an **admin** enters four values in the app at **Admin → Notification channels**
(they are *per org* — each Jira site gets its own Zulip config — and stored
**encrypted** in D1 under the `SECRETS_KEY` worker secret, which must be set first:
`openssl rand -base64 32 | wrangler secret put SECRETS_KEY`). Note `apiKey` and
`webhookToken` are **different values** — the single biggest trip-up:

| Field | Value |
| --- | --- |
| `site` | base URL, **no trailing slash** — `https://yourorg.zulipchat.com` (a trailing slash is stripped on save) |
| `botEmail` | the bot's **email** |
| `apiKey` | the bot's **API key** — sends DMs via `POST /api/v1/messages` (HTTP Basic, `x-www-form-urlencoded` — *not* JSON; see `adapters/zulip/deliver.ts`) |
| `webhookToken` | the bot's **outgoing-webhook token** — the `token` Zulip puts in every webhook POST. The app stores only its SHA-256 hash; an inbound webhook whose token matches is both authenticated *and* routed to your org. **This is NOT the API key**, and it's a distinct per-bot value. |

Saving **live-verifies** the credentials against `GET {site}/api/v1/users/me`, so a
typo'd key is rejected immediately with Zulip's own error message. The values are
write-only: the admin UI only ever shows whether the channel is configured, never the
stored values — re-enter all four to change anything. Rotating `SECRETS_KEY`
invalidates the stored config (deliveries log-and-fail); admins just re-enter it.

**Finding the outgoing-webhook token** (Zulip doesn't display it on the bot card, and
it is *not* the API key): on the **Bots** page click **"Download config of all active
outgoing webhooks"** and read the `token=` line for your bot.

Then **Settings → Notifications → Connect Zulip**: it mints a code, you DM
`/link YOURCODE` to the bot, it replies **"Connected ✓"**, and the panel flips to
connected (it polls `getStatus`).

Notes that matter:

- **The webhook fires only on DM-to-bot or @-mention** — exactly the link trigger, so
  there's no event-queue daemon to keep alive. The route additionally **accepts only a
  direct-message trigger** (`direct_message`, or the legacy `private_message` that some
  self-hosted servers still send), so a `/link CODE` pasted into a public stream can't
  redeem the code (it would otherwise leak and be replayable), and it **rate-limits
  failed `/link` attempts per sender** so a code can't be brute-forced into someone
  else's account.
- **Link codes** are bound to your account at generation, single-use, and expire in
  ~15 min (atomic redemption — `store.ts:redeemCode`). Regenerate from the panel if one
  lapses.
- **Local dev:** Zulip must reach the endpoint over the public internet, so the
  outgoing-webhook bot has to point at a deployed Worker (or a public tunnel) —
  `wrangler dev` on localhost won't receive webhooks. Outbound delivery works fine
  locally.

#### Testing Zulip delivery

**"Connected ✓" does *not* prove reminders will arrive.** That confirmation is the
webhook's echoed reply (`adapters/zulip/webhook.ts`) and only exercises the webhook
token. The actual send is a *separate* path — `POST {site}/api/v1/messages` with HTTP
Basic `botEmail:apiKey` (`adapters/zulip/deliver.ts`) — reached only by the escalation
cron. (The admin save does live-verify the bot creds against `/users/me`, which
removes most of this risk — but the test DM below is still the end-to-end proof.)

- **Fire a real test DM to yourself** (works locally *and* in prod — it's the only way
  to verify prod bot creds; it's self-scoped to your own linked channels):

  ```
  curl -X POST https://<your-worker-domain>/api/notifications/test -H 'cookie: sid=<your-sid>'
  ```

  The JSON response reports one status per linked channel — `delivered` means the bot
  credentials work; `failed` / `not_linked` / `unknown_channel` pinpoint the problem.
  Grab your `sid` from the browser dev-tools cookie after logging in.

- **Read the logs** in Workers Logs Explorer / `wrangler tail` (filter by `message`):
  - `escalate: done` — per-tick summary; `due` > 0 means escalation found un-rated
    prompts to send.
  - `escalate: delivery failed` (warn) — the send was rejected. `retryable: false` is a
    4xx (bad request / bad auth), `retryable: true` is a 5xx/429.
  - `zulip: send rejected` (warn) — the exact HTTP `status` **and Zulip's error `body`**
    (e.g. `"Invalid API key"` → bad creds; `"Invalid message type"` → server too old,
    see below). This is the line that tells you *why*.

- **Old self-hosted servers:** the send uses `type: "private"` (not `"direct"`), the
  backward-compatible message type older Zulip versions require — the same reason the
  inbound webhook tolerates the legacy `private_message` trigger.

- **Exercise the full cron path locally:** seed a prompt (`POST /api/__dev/pending`),
  run `wrangler dev --test-scheduled`, then trigger the scheduled handler:

  ```
  curl 'http://localhost:8787/__scheduled?cron=*/3+*+*+*+*'
  ```

  Note a pending must be older than `ESCALATION_DELAY_MS` (10 min) to be escalated, so
  the direct `/api/notifications/test` route above is the faster credential check.

### Email channel (optional)

The email adapter delivers via a Resend/MailChannels-style HTTP send API. Like Zulip,
it is **admin-provisioned per site**: an admin enters the `From:` address and the
transport API key under **Admin → Notification channels → email**, and the key is
live-verified then stored AES-256-GCM-encrypted (`SECRETS_KEY`) in `email_org_config`.
Users then only flip the channel on under **Settings → Notifications** and supply a
destination address — never a credential. Either a full-access or a send-only
("Sending access") Resend key works — the key is verified with a read that a send-only
key is allowed to refuse.

> **Legacy fallback.** The `EMAIL_FROM` var and `EMAIL_API_KEY` secret still work for
> any site with no admin-entered row, so existing deployments keep delivering with zero
> action. They are **deprecated** — prefer Admin → Notification channels.

It's a deliberately second implementation — it keeps the adapter abstraction honest
without needing a new setup-step kind or any change to the escalation loop.
