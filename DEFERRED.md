# Deferred work

Features intentionally postponed. Capturing them here so the intent isn't lost.

## Team aggregates

The team-aggregates series (`worker/src/routes/aggregates.ts` →
`dao.teamSeries`) currently shows a fixed window: the last 12 months, starting
no earlier than the first claim in the system. Deferred richer controls:

- **Pagination** of the series — next/previous, one year at a time, so older
  history is reachable without dumping every sprint back to 2015.
- **Range toggle** — rolling last-12-months vs. calendar year.

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
