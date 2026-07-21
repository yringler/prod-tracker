# CLAUDE.md — `migrations/`

Guidance for the D1 database migrations folder. See the repo-root
[`../CLAUDE.md`](../CLAUDE.md) for global conventions (dates/times, deferred work)
and [`../README.md`](../README.md) for the project overview — this file summarizes
and points rather than duplicating them.

## Orientation

- These are the **versioned, idempotent SQL migrations** for the project's
  Cloudflare D1 (SQLite) database — the source of truth for the D1 schema *in production*.
- Wrangler applies them with `wrangler d1 migrations apply` (wired through the
  `db:migrate*` npm scripts) and records which files have run in a `d1_migrations`
  table, so each file runs **once, in order**.
- Config lives in [`../wrangler.toml`](../wrangler.toml): the `[[d1_databases]]`
  binding (`DB`, database `storypoint-tracker`) sets `migrations_dir = "migrations"`.
- Current files: `0001_initial_schema.sql` … `0010_risk_board.sql`
  (zero-padded, one per change — see the folder listing).

## Current schema (what the migrations establish)

All timestamps are ISO-8601 **TEXT (UTC)**; points/money are `REAL`. One line per table:

- **`oauth_tokens`** — one Atlassian 3LO grant per `account_id` (rotating refresh token + cached access token).
- **`user_sites`** — the sites (`cloud_id`s) a token can reach; the org/identity boundary for aggregates.
- **`users`** — per-account profile: `display_name`, `cloud_id`, `needs_reauth`, plus `daily_goal` + `avatar_url` (added in 0004).
- **`admins`** — who holds admin (`appointed_by` / `appointed_at`).
- **`teams`** — team id + `cloud_id` + name.
- **`team_memberships`** — effective-dated (`effective_from` / nullable `effective_to`); at most one open row per account.
- **`issue_state`** — poller idempotency: highest changelog id already processed per `(cloud_id, issue_key)`.
- **`ratings`** — self-ratings. `claimed_points`, `rated_at`, plus snapshot columns `story_points_at_rating`, `team_id_at_rating`, `sprint_id`; `transitioned_at` (added 0003, bucketing key with `rated_at` fallback); `notes` / `title` / `url` (added 0002, reflection/history fields).
- **`done_events`** — the "real Jira" done series, one row per changelog transition; snapshots `account_id` + `team_id_at_done`.
- **`sprints`** — sprint window metadata (`start_at` / `end_at`) per `(cloud_id, sprint_id)`.
- **`pending_ratings`** — one prompt per unseen transition until rated (`pending_id = ${cloudId}:${issueKey}:${changelogId}`).
- **`push_subscriptions`** — Web Push endpoints per account.
- **`config`** — per-`cloud_id` Jira field ids + `done_status_names` (JSON) + `site_url`.
- **`sessions`** — server session rows.
- **`pd_report_state`** — GDPR report-accounts cadence (`last_reported_at`, gates the ≥7-day cycle).
- **`user_channels`** — app-owned notification channel registry per account (channel enum + opaque label; added 0005).
- **`zulip_links`** / **`zulip_link_codes`** / **`zulip_link_attempts`** — Zulip adapter-owned link rows, single-use TTL'd codes, and rate-limit attempts (added 0006; `zulip_links.cloud_id` — the link's org — added 0008).
- **`email_links`** — email adapter-owned delivery addresses (added 0007).
- **`risk_board_config`** / **`risk_snapshots`** / **`risk_board_state`** — Sprint Risk Board, feature-owned (added 0010): per-org admin config (board ids, cutoff/composite/schedule JSON, optional custom-field ids, the refresher account — nothing secret, so no encryption), one overwrite-only snapshot blob per board, and the demand-driven refresh state (last viewed/refreshed, consecutive failures, `degraded_reason`). Touched ONLY by [`../worker/src/risk/store.ts`](../worker/src/risk/store.ts) via `env.DB`, never by `dao.ts`; they hold Jira data, not effort ratings, so the privacy invariant is unaffected.
- **`zulip_org_config`** — per-org (cloud_id) admin-entered Zulip credentials: AES-256-GCM `secrets_enc` under the `SECRETS_KEY` worker secret + `webhook_token_hash` (sha256; unique — routes inbound webhooks to the org). Added 0008.

**Privacy-relevant columns:** `ratings.rater_account_id` is PD; `ratings.team_id_at_rating`
and `ratings.story_points_at_rating` (and `done_events.account_id` / `team_id_at_done`) are
per-account snapshots. The DAO enforces a load-bearing privacy invariant over these
(personal reads are self-scoped; aggregate paths expose sums only, never a per-account
breakdown). That logic lives in [`../worker/src/db/dao.ts`](../worker/src/db/dao.ts) and is
tested in `../worker/test/privacy.test.ts` (see [`../worker/CLAUDE.md`](../worker/CLAUDE.md)).

## How to add a migration

1. **Create** the numbered file:
   ```
   npm run db:migrate:new     # wrangler d1 migrations create storypoint-tracker
   ```
   This scaffolds the next `NNNN_...sql`; then edit it.
2. **Name / number** it zero-padded `NNNN_snake_case.sql`, matching the existing files
   (e.g. `0005_add_widget.sql`). Keep the leading comment describing intent + which
   `schema.sql` columns it mirrors, like the current migrations do.
3. **Make it idempotent and additive.** Prefer `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, and `ALTER TABLE ... ADD COLUMN`. Each file runs
   exactly once and is tracked in `d1_migrations`.
4. **Never edit a migration that has already been applied to remote/prod** — add a new
   numbered file instead. Editing an applied file is silently skipped remotely and
   diverges local from prod.
5. **Apply / inspect:**
   ```
   npm run db:migrate           # wrangler d1 migrations apply storypoint-tracker --local
   npm run db:migrate:remote    # ... apply ... --remote   (production)
   npm run db:migrate:list      # ... migrations list ... --local
   npm run db:reset:local       # rm -rf .wrangler/state/v3/d1 && npm run db:migrate
   ```
   `db:reset:local` wipes the local dev D1 state and re-applies every migration from scratch.

## Relationship to `worker/src/db/schema.sql`

- `schema.sql` is a **full, hand-maintained schema snapshot** — it is the schema the
  **tests** build from, not a live artifact of the migrations.
- `worker/test/support/sqlite-d1.ts` reads `schema.sql` and `db.exec()`s it into an
  in-memory better-sqlite3 database; every DAO test runs the real SQL against *that*.
  Tests do **not** replay the `migrations/` files.
- **Therefore: adding a migration that changes the schema means you must also update
  `worker/src/db/schema.sql`** to match, or tests will run against a stale schema and
  diverge from production. Keep the two in lockstep (0002/0003/0004 each already note
  "mirrors / keep in sync with `schema.sql`").
- Note the header comment in `schema.sql` mentions a manual
  `wrangler d1 execute ... --file worker/src/db/schema.sql` bootstrap; day-to-day the
  authoritative path for the real DB is the migrations here.

## Migrations vs. maintenance scripts

- Files in [`../scripts/`](../scripts/) (e.g. `collapse-membership-splits.sql`) are
  **one-off manual maintenance**, run explicitly via `db:cleanup:memberships` /
  `db:cleanup:memberships:remote` (`wrangler d1 execute ... --file scripts/...`).
- They are **not** in `migrations_dir`, **not** tracked in `d1_migrations`, and **not**
  auto-applied by `db:migrate*`. They are idempotent so they can be re-run by hand.
- Rule of thumb: schema/DDL changes → a numbered migration here. Data fix-ups you run
  deliberately and occasionally → a script in `scripts/`.

---
Keep this file up to date as the migration workflow or schema evolves.
