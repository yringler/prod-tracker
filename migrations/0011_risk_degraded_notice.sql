-- Org-level "we already told the admins" stamp for the risk board's degraded
-- episodes. Collapses per org (cloud_id), not per board, so a 5-board org sends
-- one message. Claimed with a CAS (see worker/src/risk/store.ts
-- claimDegradedNotice) — the same claim-before-send idiom as issue_reminders
-- (0009). Mirrors worker/src/db/schema.sql.
ALTER TABLE risk_board_config ADD COLUMN degraded_notified_at TEXT;      -- ISO UTC; NULL = no open episode
ALTER TABLE risk_board_config ADD COLUMN degraded_notified_reason TEXT;  -- NULL | 'needs_reauth' | 'errors'
