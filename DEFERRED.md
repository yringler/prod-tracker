# Deferred work

Features intentionally postponed. Capturing them here so the intent isn't lost.

## Team aggregates

The team-aggregates series (`worker/src/routes/aggregates.ts` →
`dao.teamSeries`) currently shows a fixed window: the last 12 months, starting
no earlier than the first claim in the system. Deferred richer controls:

- **Pagination** of the series — next/previous, one year at a time, so older
  history is reachable without dumping every sprint back to 2015.
- **Range toggle** — rolling last-12-months vs. calendar year.

## Escalation reminder: during-cooldown transition is window-closed, not re-nudged

**FOR HUMAN CONFIRMATION.** In `worker/src/cron/escalate.ts`, a genuinely-newer
transition that arrives while an issue is still inside its reminder cooldown is
`escalated_at`-closed on the same tick (it's part of the "full due set" passed to
`markEscalated`) and does NOT get a delayed re-send. A further reminder fires only
if a *strictly-newer* transition lands *after* the cooldown. This is deliberate —
one issue-level nudge per cooldown window, anti-spam — but it diverges from a
literal reading of the "transitioned AND ≥10 min since last reminder" rule, so it
needs a human sign-off that the window-closer behavior matches intent.

Alternative, if eventual re-nudge is the desired behavior instead: exclude
cooldown-suppressed rows from the `markEscalated` set (so they stay pending and
re-select once the cooldown passes), and flip the corresponding assertion in
`worker/test/escalate.test.ts` (`escalatedAt('p-b')` in the "cooldown suppresses a
genuinely-newer transition" test expects non-null today). Not implemented now.

## Pending "unit" key: cross-site same issue-key collision

The three per-issue collapse paths in `worker/src/pending.ts` disagree with the
SQL layer on what identifies "one rateable unit," and none of the in-memory
paths include `cloudId` in the key:

- `groupPendingByIssue` (read) keys on `issueKey` alone.
- `selectEscalations` (escalate) keys on `accountId + issueKey`
  (`EscalationCandidate` has no `cloudId` field at all).
- The claim/clear SQL (`deletePendingForIssue`, `getPendingForIssue` in
  `dao.ts`) scopes by `(account, cloud, issueKey)`.

So if one user has the **same issue key across two Jira sites (cloudIds)**, the
in-memory collapses would merge rows that the DB treats as distinct. Narrow
edge case (cross-site duplicate keys for the same person), currently only
reachable in multi-site setups. Deferred a deliberate decision: pick one
canonical unit key (`account + cloud + issueKey`) and align all three paths +
`EscalationCandidate`, or explicitly accept/document the merge.
