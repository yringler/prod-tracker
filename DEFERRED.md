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

## Sprint Risk Board: Story Points signal is invisible in the UI

`worker/src/risk/refresh.ts` maps `points` from the app's **discovered** Story
Points field. When discovery is ambiguous the repo stores `story_points_field_id
= NULL` (a load-bearing invariant — never guess an id), and then every risk ticket
gets `points: null`, so `resolveCutoff` collapses to the `size:'none'` row and the
size-specific cutoff tables never apply. Shipped now: a per-org warning log in
`refreshOrg`. Deferred, because it crosses shared types + route + UI:

- a `pointsFieldMissing` flag on `RiskBoardSnapshot` and an admin/board callout
  pointing at the existing field picker (`routes/admin.ts` `setFields`);
- optionally a second, admin-picked estimate field id (the userscript reads
  `storyPointEstimate` as a fallback, `artifacts/0_userscript.js` L596).

## Sprint Risk Board: no eslint wall around the risk slice

The feature's deletion story rests on "only `worker/src/risk/store.ts` touches the
`risk_*` tables" and "nothing in the core app reaches into `risk/`", but unlike
`notifications/adapters/**` neither is CI-enforced in `.eslintrc.cjs`. Deferred
because the rule needs exceptions from day one (`risk/routes.ts` legitimately
imports `routes/dev`, `index.ts` and `cron/pd-report.ts` legitimately import
`risk/`), and adding it touches an existing file outside the plan's §2e
registration list. Revisit if a second feature slice appears and the pattern
needs to be a rule rather than a convention.
