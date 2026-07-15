-- Notification channels: the app-owned map account_id -> [channel enum + opaque label].
-- The app stores ONLY the channel enum and a display label it renders but never parses;
-- the vendor address (e.g. a zulip_user_id) stays inside the adapter's own tables.
-- Plus pending_ratings.escalated_at: the marker the escalation cron sets so a pending is
-- escalated at most once. Mirrors worker/src/db/schema.sql.
CREATE TABLE IF NOT EXISTS user_channels (
  account_id  TEXT NOT NULL,
  channel     TEXT NOT NULL,          -- runtime enum: 'zulip', 'email', ...
  label       TEXT NOT NULL,          -- opaque display string ("Connected as @yehuda")
  linked_at   TEXT NOT NULL,          -- ISO UTC
  PRIMARY KEY (account_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_user_channels_account ON user_channels(account_id);

ALTER TABLE pending_ratings ADD COLUMN escalated_at TEXT; -- ISO UTC; NULL = not yet escalated
