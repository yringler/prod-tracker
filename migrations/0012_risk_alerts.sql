-- Sprint Risk Board Phase 2: per-ticket alert hysteresis state + per-user opt-out.
-- Accessed ONLY by worker/src/risk/store.ts via env.DB — never dao.ts.
-- Mirrors worker/src/db/schema.sql.

-- One row per ticket per board *while it is in (or just out of) a risk episode*.
-- No row = armed and clean. Rows are deleted when a ticket leaves the board or
-- has been clean past the re-fire cooldown, so the table stays tiny.
CREATE TABLE IF NOT EXISTS risk_alert_state (
  cloud_id          TEXT NOT NULL,
  board_id          INTEGER NOT NULL,
  issue_key         TEXT NOT NULL,
  phase             TEXT NOT NULL DEFAULT 'armed',  -- armed | firing | recovered
  risk_since        TEXT,     -- ISO UTC: start of the current continuous at-risk run; NULL = not at risk
  risk_streak       INTEGER NOT NULL DEFAULT 0,     -- diagnostic only (tuning/observability)
  last_notified_at  TEXT,     -- ISO UTC of the last fire (NULL = fired-but-unreachable or never)
  last_payload_hash TEXT,     -- content hash of the last fired alert (adapter dedup hint + observability)
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (cloud_id, board_id, issue_key)
);

-- Per-user opt-out for struggling-ticket nudges. Risk-owned (not users/dao.ts) so
-- deletion of the feature drops it. Keyed by Atlassian account_id, same id space
-- as user_channels.
CREATE TABLE IF NOT EXISTS risk_alert_prefs (
  account_id  TEXT PRIMARY KEY,
  muted       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
