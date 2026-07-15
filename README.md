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

Sending and receiving are two different Zulip bot types (Zulip → *gear* → *Personal*
(or *Organization*) *settings* → **Bots** → *Add a new bot*). Neither bot needs
org-admin — the link flow stores your numeric Zulip `user_id` (captured from the DM
you send), never your email, so it works regardless of Zulip's `email_address_visibility`
settings.

1. **Generic bot — for *sending*.** Create a *Generic bot* (e.g. "notify"). Copy its
   **email** → `ZULIP_BOT_EMAIL` and its **API key** → `ZULIP_API_KEY`. This posts
   your reminders via `POST /api/v1/messages` (HTTP Basic, `x-www-form-urlencoded` —
   *not* JSON; see `adapters/zulip/deliver.ts`).
2. **Outgoing-webhook bot — for *receiving* the `/link` DM.** Create an *Outgoing
   webhook* bot and set its **Endpoint URL** to:

   ```
   https://<your-worker-domain>/api/notifications/zulip/webhook
   ```

   Copy the bot's **token** (shown in its config — Zulip includes it in every webhook
   POST) → `ZULIP_WEBHOOK_TOKEN`. The route verifies it (token-is-capability) before
   doing anything.
3. Set `ZULIP_SITE` to your Zulip base URL (`https://yourorg.zulipchat.com`).
4. Deploy, then **Settings → Notifications → Connect Zulip**: it mints a code, you DM
   `/link YOURCODE` to the bot, it replies **"Connected ✓"**, and the panel flips to
   connected (it polls `getStatus`).

Config recap — **vars** go in `wrangler.toml [vars]`, **secrets** via `wrangler secret
put` (or `.dev.vars` locally):

| Key | Kind | Value |
| --- | --- | --- |
| `ZULIP_SITE` | var | `https://yourorg.zulipchat.com` |
| `ZULIP_BOT_EMAIL` | var | the **generic** bot's email |
| `ZULIP_API_KEY` | secret | the **generic** bot's API key |
| `ZULIP_WEBHOOK_TOKEN` | secret | the **outgoing-webhook** bot's token |

Notes that matter:

- **The webhook fires only on DM-to-bot or @-mention** — exactly the link trigger, so
  there's no event-queue daemon to keep alive. The route additionally **guards
  `trigger === 'direct_message'`**, so a `/link CODE` pasted into a public stream can't
  redeem the code (it would otherwise leak and be replayable), and it **rate-limits
  failed `/link` attempts per sender** so a code can't be brute-forced into someone
  else's account.
- **Link codes** are bound to your account at generation, single-use, and expire in
  ~15 min (atomic redemption — `store.ts:redeemCode`). Regenerate from the panel if one
  lapses.
- **One bot instead of two?** An outgoing-webhook bot can also send via its own API
  key, so you may point `ZULIP_BOT_EMAIL`/`ZULIP_API_KEY` at the *same* outgoing-webhook
  bot for a single, coherent identity (you DM and hear back from one bot). The two-bot
  split above mirrors the design doc (`notifaction-adapters.md` §7); either works.
- **Local dev:** Zulip must reach the endpoint over the public internet, so the
  outgoing-webhook bot has to point at a deployed Worker (or a public tunnel) —
  `wrangler dev` on localhost won't receive webhooks. Outbound delivery works fine
  locally.

### Email channel (optional)

The email adapter delivers via a Resend/MailChannels-style HTTP send API. Set
`EMAIL_FROM` (var, the `From:` address) and `EMAIL_API_KEY` (secret), then enter a
destination address under **Settings → Notifications → email**. It's a deliberately
second implementation — it keeps the adapter abstraction honest without needing a new
setup-step kind or any change to the escalation loop.
