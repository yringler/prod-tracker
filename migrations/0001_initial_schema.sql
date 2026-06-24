-- Baseline schema (migration 0001). Mirrors worker/src/db/schema.sql as it stood
-- before the reflection/notes feature. Everything is IF NOT EXISTS, so applying
-- this against the pre-existing production DB is a no-op that simply records the
-- baseline in the d1_migrations table. Incremental changes go in later migrations.
-- All timestamps are ISO-8601 TEXT (UTC). Money/points kept as REAL.

CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id     TEXT PRIMARY KEY,
  refresh_token  TEXT NOT NULL,
  access_token   TEXT,
  expires_at     TEXT
);

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
  needs_reauth  INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS team_memberships (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  effective_from  TEXT NOT NULL,
  effective_to    TEXT
);
CREATE INDEX IF NOT EXISTS idx_memberships_account ON team_memberships(account_id, effective_from);

CREATE TABLE IF NOT EXISTS issue_state (
  cloud_id               TEXT NOT NULL,
  issue_key              TEXT NOT NULL,
  last_seen_changelog_id TEXT,
  PRIMARY KEY (cloud_id, issue_key)
);

CREATE TABLE IF NOT EXISTS ratings (
  id                     TEXT PRIMARY KEY,
  cloud_id               TEXT NOT NULL,
  issue_key              TEXT NOT NULL,
  rater_account_id       TEXT NOT NULL,
  claimed_points         REAL NOT NULL,
  story_points_at_rating REAL,
  team_id_at_rating      TEXT,
  sprint_id              INTEGER,
  rated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ratings_rater ON ratings(rater_account_id);
CREATE INDEX IF NOT EXISTS idx_ratings_agg ON ratings(cloud_id, team_id_at_rating, sprint_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ratings_pending
  ON ratings(rater_account_id, issue_key, sprint_id, claimed_points);

CREATE TABLE IF NOT EXISTS done_events (
  id                     TEXT PRIMARY KEY,
  cloud_id               TEXT NOT NULL,
  issue_key              TEXT NOT NULL,
  story_points           REAL,
  sprint_id              INTEGER,
  transitioned_to_done_at TEXT NOT NULL,
  changelog_id           TEXT NOT NULL,
  account_id             TEXT,
  team_id_at_done        TEXT
);
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

CREATE TABLE IF NOT EXISTS pending_ratings (
  pending_id      TEXT PRIMARY KEY,
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
  done_status_names     TEXT NOT NULL DEFAULT '[]',
  site_url              TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  cloud_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pd_report_state (
  account_id        TEXT PRIMARY KEY,
  last_reported_at  TEXT NOT NULL
);
