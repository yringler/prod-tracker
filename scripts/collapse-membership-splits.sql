-- One-time cleanup: collapse redundant team-membership splits.
--
-- The old non-idempotent assignMembership closed and reopened a membership on
-- every Assign, so re-assigning someone to the team they were already on split
-- one continuous membership into an ended row + a new open row at the same
-- instant (effective_to of one row == effective_from of the next, same
-- account + team). This merges each maximal contiguous same-team run back into
-- a single row [run start, run end]. Genuine history (a real gap, or leaving
-- and later rejoining the same team) is non-contiguous and left untouched.
--
-- Safe to re-run (idempotent): once collapsed, no contiguous pairs remain so
-- both statements become no-ops.
--
-- Apply via:  npm run db:cleanup:memberships            (local)
--             npm run db:cleanup:memberships:remote      (production)

-- Step 1: extend the surviving (terminal) row of each contiguous same-team run
-- back to the run's earliest start. The terminal is the row with no same-team
-- successor; run_start is reached by walking predecessors (where one row's
-- effective_to meets the next row's effective_from).
WITH RECURSIVE chain(id, account_id, team_id, run_start) AS (
  -- run roots: rows with no contiguous same-team predecessor
  SELECT id, account_id, team_id, effective_from
  FROM team_memberships m
  WHERE NOT EXISTS (
    SELECT 1 FROM team_memberships p
    WHERE p.account_id = m.account_id AND p.team_id = m.team_id
      AND p.effective_to = m.effective_from)
  UNION ALL
  -- carry run_start forward to each contiguous same-team successor
  SELECT n.id, n.account_id, n.team_id, c.run_start
  FROM chain c
  JOIN team_memberships cur ON cur.id = c.id
  JOIN team_memberships n
    ON n.account_id = c.account_id AND n.team_id = c.team_id
   AND n.effective_from = cur.effective_to
)
UPDATE team_memberships
SET effective_from = (SELECT run_start FROM chain WHERE chain.id = team_memberships.id)
WHERE
  -- terminal rows only (no same-team successor)
  NOT EXISTS (
    SELECT 1 FROM team_memberships s
    WHERE s.account_id = team_memberships.account_id
      AND s.team_id = team_memberships.team_id
      AND s.effective_from = team_memberships.effective_to)
  -- and only where it actually extends an earlier start
  AND effective_from <> (SELECT run_start FROM chain WHERE chain.id = team_memberships.id);

-- Step 2: delete the now-redundant rows — any row whose interval is fully
-- covered by another same-team row for the same account (the extended terminal
-- from step 1 covers all its predecessors). Strict containment, with an id
-- tiebreak so exact-duplicate rows don't delete each other.
DELETE FROM team_memberships AS r
WHERE EXISTS (
  SELECT 1 FROM team_memberships s
  WHERE s.account_id = r.account_id
    AND s.team_id = r.team_id
    AND s.id <> r.id
    AND s.effective_from <= r.effective_from
    AND (s.effective_to IS NULL OR (r.effective_to IS NOT NULL AND s.effective_to >= r.effective_to))
    AND (
         s.effective_from < r.effective_from
      OR (s.effective_to IS NULL AND r.effective_to IS NOT NULL)
      OR (r.effective_to IS NOT NULL AND s.effective_to > r.effective_to)
      OR (s.effective_from = r.effective_from
          AND (s.effective_to = r.effective_to
               OR (s.effective_to IS NULL AND r.effective_to IS NULL))
          AND s.id < r.id)
    ));
