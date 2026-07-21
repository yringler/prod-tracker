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
`refreshOrg`.

**Partly closed by the cutoffs editor.** `GET /api/admin/risk/columns` returns
`pointsFieldConfigured`, and `<sp-risk-cutoffs>` uses it to disable the whole Size
column with a callout ("every ticket counts as Unpointed — size rules will never
fire"), pointing at the field picker on the same page; `validateCutoffs` also emits
a `NO_POINTS_FIELD` warning per metric that has size rules. Still deferred:

- the **board-side** half — a `pointsFieldMissing` flag on `RiskBoardSnapshot` and a
  callout on `/risk` itself (the admin page is now covered, the viewer's isn't);
- optionally a second, admin-picked estimate field id (the userscript reads
  `storyPointEstimate` as a fallback, `artifacts/0_userscript.js` L596).

## Sprint Risk Board: the cutoffs editor's next steps

`client/src/app/risk/cutoffs-editor.component.ts` + `shared/src/risk-cutoffs.ts`
replaced the raw-JSON textarea (see the plan in
`artifacts/2_risk_cutoffs_ui_plan.md`).

**Shipped since:** the **impact preview** ("with these thresholds: 12 at risk /
9 warning / 40 healthy, was 6 / 8 / 47") — `POST /api/admin/risk/preview`
(`worker/src/risk/logic/preview.ts`) re-runs `evaluateTicket` over the stored
snapshots' tickets for zero Jira calls, and `<sp-risk-impact>` renders it debounced
under the editors. Two limits it states rather than hides: it previews thresholds
and weights only, so a **work-schedule** edit is flagged `scheduleStale` (the stored
clock values can only be re-measured by a real refresh), and it scores the boards
**already saved** — a board just ticked in the picker has no snapshot to score until
the refresher runs.

Still deliberately NOT built:

- **Per-board cutoffs.** `cutoffs_json` is per ORG while columns are per BOARD, so a
  `column:` rule can apply to one configured board and silently not another. That
  needs a schema change; in the meantime `validateCutoffs`'s
  `COLUMN_NOT_ON_EVERY_BOARD` warning names both boards, which covers the pain.
- **Rejecting dead `Done` rules server-side.** "Last column" is per-board, so a rule
  that is dead on one board can be correct on another — it stays a warning
  (`DONE_COLUMN_RULE`) plus a disabled option in the Scope picker, never a 400.
- **A visual work-schedule editor** (7 day rows + a timezone picker). Reading the
  schedule and deriving every units caption from it (`workHoursPerWeek`,
  `scheduleDaysSummary`) shipped; editing it is still a JSON box on `/risk/admin`.
- **Structured `issues` for composite/schedule.** `PUT /api/admin/risk/config` still
  returns a plain message for those two; reuse `RiskConfigIssue` when their
  validators grow up.
- **A migration for the stricter validator.** Three previously-accepted shapes (a
  half-filled rule, an off-ladder `size`, a duplicated `default`) are now 400s, so an
  org holding a legacy blob cannot re-save it *unchanged*. No backfill was written:
  reads stay tolerant (`store.ts` `parseJson`), nothing breaks at refresh time, and
  the editor auto-repairs on load with a visible "we repaired N rules" callout before
  the first save. Revisit only if a real org is found stuck.

## Sprint Risk Board: no eslint wall around the risk slice

The feature's deletion story rests on "only `worker/src/risk/store.ts` touches the
`risk_*` tables" and "nothing in the core app reaches into `risk/`", but unlike
`notifications/adapters/**` neither is CI-enforced in `.eslintrc.cjs`. Deferred
because the rule needs exceptions from day one (`risk/routes.ts` legitimately
imports `routes/dev`, `index.ts` and `cron/pd-report.ts` legitimately import
`risk/`), and adding it touches an existing file outside the plan's §2e
registration list. Revisit if a second feature slice appears and the pattern
needs to be a rule rather than a convention.

## Sprint Risk Board: degraded-board alerting stops at the admin DM

`worker/src/risk/notify.ts` ships **operational** alerting only — one
channel-neutral message per degraded episode per org (plus a recovery message) to
`admins ∩ listOrgMembers(cloudId)`, deep-linking to `/risk/admin`. Deliberately
not built:

- **No admin health panel.** No `RiskAdminConfigResponse` field, no
  `risk-admin.component.ts` table of per-board `degraded_reason` / `failures` /
  `last_refresh_at`. The `/risk` badge plus the DM's deep link cover the case; a
  panel is worth it only once an operator is diagnosing rather than reacting.
- **No per-org notification preferences** for these alerts — no quiet hours, no
  opt-out, no recipient override, no new `SetupStep` kind or channel. Recipients
  are whoever the org's admins have already linked, capped at
  `MAX_NOTIFIED_ADMINS`, with `BOOTSTRAP_ADMIN_ACCOUNT_ID` as the fallback.
- **No `dao.listOrgAdmins`.** Composed from the existing `listOrgMembers` +
  `isAdmin` so `dao.ts` (the privacy-invariant file) stays out of the diff. Note
  the consequence: `admins` is global (no `cloud_id`), so an admin with no
  `user_sites` row for that org is not notified — the same scoping every other
  admin surface uses, but a real blind spot for a single-site-per-admin deploy.
- **No Phase-2 health-change notifications** (`risk_alert_state`, hysteresis, the
  `// PHASE 2:` seam in `refreshBoard`). This is "the board stopped updating", not
  "a ticket went red".
- **No suppression of the `needs_reauth` → `errors` follow-up.** With the
  eligibility self-heal in place, an org whose grant is usable but whose refreshes
  still fail will flip reason after `MAX_CONSECUTIVE_FAILURES`, which counts as a
  new episode — one org can legitimately get two messages ~15 min apart. Judged
  correct (the fix differs), flagged rather than dampened.

## OAuth scope drift: detection ships, proactive re-consent nudging does not

`worker/src/jira/scopes.ts` + the `assertScopes` gate in `jira/client.ts` detect a
grant minted under an older scope set by decoding the access token's own `scope`
claim, and route it into the **existing** `needs_reauth` machinery
(`ScopeDriftError extends ReauthRequiredError` → the "Re-connect Jira" banner from
`/api/me`, and for a risk-board refresher the degraded notice in `risk/notify.ts`).
That is the correct minimal core. Deliberately not built:

- **No login-time scope-version stamp.** The alternative design — a
  `scope_version` column on `oauth_tokens`, written at consent and compared to a
  build constant — was rejected: it needs a migration and new bookkeeping, and it
  measures *our record of what we asked for* rather than *what Atlassian actually
  granted*. It would miss the real failure mode where a user re-consents but the
  app in the developer console still doesn't offer the scope, so the grant comes
  back short and the stamp says "current". The JWT claim is ground truth and needs
  no schema change at all. Revisit only if Atlassian stops issuing JWT access
  tokens, which the fail-open path already degrades to gracefully (behavior
  reverts to today's: silent 401s).
- **No proactive sweep.** Nothing scans stored grants for drift ahead of use; a
  user is flagged the first time a Jira call is made on their behalf (the poller
  touches every grant every 3 minutes, so the lag is small). A cron sweep would be
  a second code path for a case the poller already covers within one tick.
- **No dedicated "your scopes are out of date" copy.** The banner reads "Your Jira
  consent expired", which is imprecise for drift. Distinguishing it means a new
  `MeResponse` field and client branch; not worth it for a once-per-deploy event.

**Operational note:** the release that added `read:board-scope.admin:jira-software`,
`read:issue-details:jira` and `read:jql:jira` forces **every existing user to
re-authorize once**. Tick the three new scopes on the app in the Atlassian
developer console *before* deploying, or the re-consent hands back the same short
grant and the banner reappears immediately.
