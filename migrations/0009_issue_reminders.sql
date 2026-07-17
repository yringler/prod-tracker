-- Per-issue fallback-reminder ledger: the claim-before-send serialization point
-- AND the issue-level dedup for the escalation cron. One row per
-- (cloud_id, account_id, issue_key) records the last reminder we sent — its
-- changelog id and instant — so a concurrent/overlapping escalate() tick sends at
-- most one reminder per issue, and a re-send is suppressed until the issue both
-- transitions again (a greater changelog id) AND the cooldown elapses
-- (shared mayRemind). Distinct from pending_ratings.escalated_at, which is the
-- per-row window-closer that stops pendingDueForEscalation re-selecting a row.
-- Mirrors worker/src/db/schema.sql.
CREATE TABLE IF NOT EXISTS issue_reminders (
  cloud_id                   TEXT NOT NULL,
  account_id                 TEXT NOT NULL,
  issue_key                  TEXT NOT NULL,
  last_reminded_changelog_id TEXT NOT NULL,
  last_reminded_at           TEXT NOT NULL,   -- ISO UTC
  PRIMARY KEY (cloud_id, account_id, issue_key)
);
