-- Sprint Risk Board (feature-owned tables). Accessed ONLY by
-- worker/src/risk/store.ts via env.DB — never by dao.ts, which keeps the privacy
-- invariant's file out of this feature's diff entirely. The board shows per-ticket
-- Jira data every org member can already see in Jira; it stores no effort ratings.
-- Deleting the feature = dropping these three tables (see the plan's §6).
-- Mirrors worker/src/db/schema.sql.

-- Per-org risk-board config, admin-entered. Nothing here is secret (board ids,
-- cutoff tables, a refresher account id) — plain columns, no encryption.
CREATE TABLE IF NOT EXISTS risk_board_config (
  cloud_id             TEXT PRIMARY KEY,
  boards_json          TEXT NOT NULL DEFAULT '[]',  -- [{boardId:number, name:string}]
  cutoffs_json         TEXT,    -- RiskCutoffs; NULL = code defaults
  composite_json       TEXT,    -- {p, weights}; NULL = code defaults
  work_schedule_json   TEXT,    -- RiskWorkSchedule; NULL = NY default
  fields_json          TEXT,    -- RiskFieldConfigEntry[] (label/fieldId/kind/warn/risk/weight)
  in_progress_status   TEXT,    -- NULL = 'In Progress'
  dev_status_available INTEGER, -- NULL = unprobed; 0/1 = probe result (gates the PR feature)
  refresher_account_id TEXT,    -- whose oauth_tokens row the cron refresher uses
  configured_by        TEXT,    -- admin account_id (audit)
  updated_at           TEXT NOT NULL
);

-- One snapshot per board, overwritten each refresh (the write path); the read
-- route serves it verbatim with zero Jira calls. Overwrite-only = idempotent.
CREATE TABLE IF NOT EXISTS risk_snapshots (
  cloud_id      TEXT NOT NULL,
  board_id      INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,   -- RiskBoardSnapshot blob
  computed_at   TEXT NOT NULL,   -- ISO UTC
  PRIMARY KEY (cloud_id, board_id)
);

-- Demand-driven refresh state: last_viewed_at is the demand signal (set by the
-- read route), the rest is the scheduler's staleness/backoff bookkeeping.
CREATE TABLE IF NOT EXISTS risk_board_state (
  cloud_id        TEXT NOT NULL,
  board_id        INTEGER NOT NULL,
  last_viewed_at  TEXT,
  last_refresh_at TEXT,             -- last successful refresh
  last_attempt_at TEXT,
  failures        INTEGER NOT NULL DEFAULT 0,   -- consecutive; reset on success
  degraded_reason TEXT,             -- NULL | 'needs_reauth' | 'errors'
  PRIMARY KEY (cloud_id, board_id)
);
