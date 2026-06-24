-- Bucket claimed points by the Jira transition day, not the claim day.
-- submitRating stamps rated_at = now() (when the user claimed). We also persist
-- the transition timestamp from the pending prompt so day/week views can group by
-- when the work was actually done. Nullable: rows predating this column fall back
-- to rated_at via COALESCE in the bucketing queries.
ALTER TABLE ratings ADD COLUMN transitioned_at TEXT;
