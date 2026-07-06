-- Personal settings + profile: a self-set daily claimed-points goal (drives the
-- tracker's goal-progress panel) and the Atlassian avatar captured at login
-- (shown in the header chip). Mirrors the new columns in worker/src/db/schema.sql.
ALTER TABLE users ADD COLUMN daily_goal REAL;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
