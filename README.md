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

> Edge case (hook left for later): a single-person team makes aggregate == individual.
> A future minimum-team-size floor would go in the aggregate query.

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
wrangler d1 execute storypoint-tracker --file worker/src/db/schema.sql

npm run build:client           # ng build -> client/dist/client/browser
npm run dev                    # wrangler dev (serves API + SPA)
npm run deploy                 # build client + wrangler deploy
```

### Atlassian app setup

OAuth 2.0 (3LO) app with scopes:
`read:jira-work read:jira-user read:board-scope:jira-software read:sprint:jira-software offline_access`,
callback `https://<your-worker>/api/auth/callback`. Set `JIRA_CLIENT_ID/SECRET` as
secrets. VAPID keypair (base64url raw) as `VAPID_PUBLIC_KEY/PRIVATE_KEY`.

## Open flags (decide against your Jira)

- **Search endpoint/pagination**: `worker/src/jira/search.ts` uses
  `/rest/api/3/search` with token paging. Atlassian is migrating to
  `/rest/api/3/search/jql`; confirm which your instance expects.
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
