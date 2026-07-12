-- D1 schema. Applied via: wrangler d1 execute storypoint-tracker --file worker/src/db/schema.sql
-- All timestamps are ISO-8601 TEXT (UTC). Money/points kept as REAL.

-- ONE grant per Atlassian account. A single 3LO refresh token works across every
-- accessible site (cloudId), so it is keyed by account_id only — storing it per
-- cloud would duplicate the rotating token and invalidate copies on refresh.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id     TEXT PRIMARY KEY,
  refresh_token  TEXT NOT NULL,   -- rotating: replaced on every refresh
  access_token   TEXT,
  expires_at     TEXT             -- ISO; when access_token expires
);

-- The sites (cloudIds) one account's token can reach, from accessible-resources.
-- This is the org/identity boundary: a user sees aggregates only for these clouds.
CREATE TABLE IF NOT EXISTS user_sites (
  account_id  TEXT NOT NULL,
  cloud_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  site_url    TEXT NOT NULL,
  PRIMARY KEY (account_id, cloud_id)
);
CREATE INDEX IF NOT EXISTS idx_user_sites_account ON user_sites(account_id);

CREATE TABLE IF NOT EXISTS users (
  account_id    TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  cloud_id      TEXT NOT NULL,
  last_seen_at  TEXT,
  needs_reauth  INTEGER NOT NULL DEFAULT 0,
  daily_goal    REAL, -- self-set daily claimed-points goal; NULL = not set
  avatar_url    TEXT  -- Atlassian profile picture captured at login
);

CREATE TABLE IF NOT EXISTS admins (
  account_id    TEXT PRIMARY KEY,
  appointed_by  TEXT,
  appointed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  team_id   TEXT PRIMARY KEY,
  cloud_id  TEXT NOT NULL,
  name      TEXT NOT NULL
);

-- Effective-dated membership: at most one open row (effective_to IS NULL) per account.
CREATE TABLE IF NOT EXISTS team_memberships (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  effective_from  TEXT NOT NULL,
  effective_to    TEXT             -- nullable = currently effective
);
CREATE INDEX IF NOT EXISTS idx_memberships_account ON team_memberships(account_id, effective_from);

-- Idempotency: highest changelog id we've already processed for an issue.
CREATE TABLE IF NOT EXISTS issue_state (
  cloud_id               TEXT NOT NULL,
  issue_key              TEXT NOT NULL,
  last_seen_changelog_id TEXT,
  PRIMARY KEY (cloud_id, issue_key)
);

-- A self-rating. Snapshots story points AND team id at rating time so historical
-- re-aggregation stays honest when points or team membership later change.
CREATE TABLE IF NOT EXISTS ratings (
  id                     TEXT PRIMARY KEY,
  cloud_id               TEXT NOT NULL,
  issue_key              TEXT NOT NULL,
  rater_account_id       TEXT NOT NULL,
  claimed_points         REAL NOT NULL,        -- absolute self-claimed pts (UI %× story points at rating)
  story_points_at_rating REAL,                 -- nullable: ticket had no points
  team_id_at_rating      TEXT,                 -- nullable: rater on no team then
  sprint_id              INTEGER,              -- nullable: outside any sprint window
  rated_at               TEXT NOT NULL,        -- when the claim was submitted (now())
  -- The Jira transition timestamp this claim is about, snapshotted from the pending
  -- prompt. Day/week views bucket on THIS, not rated_at, so work done yesterday but
  -- claimed today lands on the transition day. Added 0003; null for legacy rows,
  -- which fall back to rated_at via COALESCE. Keep in sync with
  -- migrations/0003_rating_transitioned_at.sql.
  transitioned_at        TEXT,                 -- nullable: Jira transition time
  -- Reflection fields (added 0002). title/url snapshot the issue so the personal
  -- history view can render it without a live Jira lookup; notes is an optional
  -- free-text diary the rater writes when claiming. NOTE: these columns also live
  -- in migrations/0002_rating_notes.sql — keep both in sync.
  notes                  TEXT,                 -- nullable: optional diary note
  title                  TEXT,                 -- nullable: issue title at rating time
  url                    TEXT                  -- nullable: Jira deep-link at rating time
);
CREATE INDEX IF NOT EXISTS idx_ratings_rater ON ratings(rater_account_id);
CREATE INDEX IF NOT EXISTS idx_ratings_agg ON ratings(cloud_id, team_id_at_rating, sprint_id);
-- One rating per (rater, issue, transition). pending_id carries the changelog id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ratings_pending
  ON ratings(rater_account_id, issue_key, sprint_id, claimed_points);

-- The "real Jira" done series. Bucketed by the changelog timestamp's sprint window.
CREATE TABLE IF NOT EXISTS done_events (
  id                     TEXT PRIMARY KEY,
  cloud_id               TEXT NOT NULL,
  issue_key              TEXT NOT NULL,
  story_points           REAL,
  sprint_id              INTEGER,
  transitioned_to_done_at TEXT NOT NULL,
  changelog_id           TEXT NOT NULL,
  -- Snapshot, like ratings: the polling assignee's account + team at done-time.
  -- Needed to draw a per-team done line (the raw model has no team on done) and
  -- to keep historical attribution stable when the assignee changes teams later.
  account_id             TEXT,
  team_id_at_done        TEXT
);
-- One done_event per changelog transition (exactly-once across overlapping windows).
CREATE UNIQUE INDEX IF NOT EXISTS uq_done_changelog ON done_events(cloud_id, changelog_id);
CREATE INDEX IF NOT EXISTS idx_done_agg ON done_events(cloud_id, sprint_id);

CREATE TABLE IF NOT EXISTS sprints (
  cloud_id   TEXT NOT NULL,
  sprint_id  INTEGER NOT NULL,
  board_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  start_at   TEXT,
  end_at     TEXT,
  PRIMARY KEY (cloud_id, sprint_id)
);

-- Per-tracked pending rating prompt (one per unseen transition, until rated).
CREATE TABLE IF NOT EXISTS pending_ratings (
  pending_id      TEXT PRIMARY KEY,  -- `${cloudId}:${issueKey}:${changelogId}`
  cloud_id        TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  issue_key       TEXT NOT NULL,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL,
  story_points    REAL,
  to_status       TEXT NOT NULL,
  changelog_id    TEXT NOT NULL,
  transitioned_at TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_account ON pending_ratings(account_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  account_id  TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  PRIMARY KEY (account_id, endpoint)
);

CREATE TABLE IF NOT EXISTS config (
  cloud_id              TEXT PRIMARY KEY,
  story_points_field_id TEXT,
  sprint_field_id       TEXT,
  done_status_names     TEXT NOT NULL DEFAULT '[]', -- JSON array
  site_url              TEXT                        -- e.g. https://acme.atlassian.net
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  cloud_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- GDPR personal-data reporting cadence. One row per accountId we've reported to
-- Atlassian's report-accounts API; last_reported_at gates the >=7-day cycle
-- period so the 3-minute cron re-reports each account at most that often.
CREATE TABLE IF NOT EXISTS pd_report_state (
  account_id        TEXT PRIMARY KEY,
  last_reported_at  TEXT NOT NULL
);

-- Stripe billing (added 0005). Its own table, NOT columns on `users`: upsertUser
-- rewrites the users row on every login while billing is written by Stripe
-- webhooks on a different lifecycle. No row = trial not started; the entitlement
-- gate lazily inserts one (fresh 7-day trial) at an account's first touch, which
-- is also how grandfathered users are handled. Keep in sync with
-- migrations/0005_billing.sql.
CREATE TABLE IF NOT EXISTS billing (
  account_id             TEXT PRIMARY KEY,
  trial_started_at       TEXT NOT NULL,       -- first login (or first touch post-deploy)
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  subscription_status    TEXT,                -- Stripe status verbatim; NULL = never subscribed
  current_period_end     TEXT,                -- ISO
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_customer ON billing(stripe_customer_id);
