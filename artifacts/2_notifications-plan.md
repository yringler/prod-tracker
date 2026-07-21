# Phase 2 Plan — Sprint Risk Board health-change notifications

> **Status.** Implementation plan for the deferred Phase 2 of
> `1_replacement-plan.md` (§3): the arch doc's §9 "health-change notifications",
> adapted to the code that actually landed in Phase 0+1 (commits `17c3b7d`,
> `c49d54b`). Grounded in the landed `worker/src/risk/` module — especially
> `notify.ts` (the existing degraded-org notices, whose patterns this phase
> reuses: pure policy functions, channel-neutral payloads, `registry.resolve()`
> only, claim-before-send CAS). §2 lists where arch §9's assumptions had to bend
> to the real code.

## 1. Goals / non-goals

**Goals (v1):**
- When a ticket has been continuously at `risk` tier for a conservative amount of **work-hours**, send its assignee one private nudge ("this one looks stuck — worth a second pair of eyes?") through their already-linked notification channels, via `registry.resolve()` only.
- Hysteresis + transition-only firing: one message on the edge into "struggling", silence while it stays there, re-arm only after the ticket returns to `ok` (or leaves the board / goes done), and a re-fire cooldown after recovery.
- Ticket-level alert, metric-level "driven by" payload mirroring the triage row (blocked > idle > in-column > cycle > rejections, plus composite).
- Aggregate per recipient per board-refresh: k tipping tickets = one message listing k.
- Quiet hours via the org's `RiskWorkSchedule` work clock: fires are **held, not dropped** — the transition simply isn't consumed until a refresh that lands inside work hours.
- A per-user opt-out toggle (risk-owned table, risk-owned route) — included in v1 (rationale in §6).
- Everything deletable with the feature: new code in `worker/src/risk/`, new tables `risk_alert_*` touched only by `store.ts`, no `dao.ts` writes, no adapter imports.

**Non-goals (explicitly out, noted as future):**
- "Still struggling" digest / periodic re-reminders (arch §9 routes those to a digest — Phase 3).
- Per-user severity→channel routing prefs (`getUserPrefs` in arch §9). v1's only pref is the mute toggle.
- Recovery notices to devs (the org-admin degraded/recovery notice in `notify.ts` is a different feature and stays as is).
- Per-user timezones/quiet-hours; v1 uses the org work schedule.
- Team/lead/shared-channel routing overrides (arch §14 open question) — private-to-assignee only.

## 2. Where the landed code contradicts arch §9 assumptions (flagged)

1. **`getUserPrefs` / `sendToNotifiers` bindings don't exist.** Already resolved by `1_changes-from-arch.md` deviation #4: delivery = `registry.resolve()` + `dao.getUserChannels()` (the `cron/escalate.ts` / `risk/notify.ts` idiom, first-success-wins across a user's channels). Severity routing has no pref surface at all today — hence v1 mute-only.
2. **The Phase-2 seam is in `refreshBoard`, not `refreshOrg`** (`refresh.ts:544`, between snapshot assembly and `overwriteSnapshot`). The diff step therefore runs **per board**; per-recipient aggregation is per board-refresh, not per org-tick. This is fine: boards refresh on independent cadences anyway (5 min active vs ~60 min idle), so same-tick multi-board collapse would rarely collapse anything; the post-weekend storm arch §9 worries about is intra-board. Accepting per-board aggregation keeps the arch's step ordering (state write → snapshot overwrite) inside one function. A person with tickets tipping on two boards in the same tick gets at most one message per board — bounded, rare, accepted.
3. **Arch §9's step order (5: send, 6: write state) is unsafe under the repo's own CAS idiom.** The landed pattern everywhere (`dao.claimReminder`, `store.claimDegradedNotice`) is **claim-before-send**: persist the claim, then deliver, accepting "lost, never duplicated". The plan inverts arch steps 5/6 accordingly. This is deliberate and matches "don't cry wolf" — a crash costs one missed nudge, not a duplicate.
4. **`alert_state` keyed `tenant+ticketKey` (arch) is insufficient**: the diff runs per board and needs per-board cleanup of departed tickets, and one issue can sit on two configured boards. Key becomes `(cloud_id, board_id, issue_key)`.
5. **Migration number: `0011` is taken** (`0011_risk_degraded_notice.sql`, commit `c49d54b`). The new migration is **`migrations/0012_risk_alerts.sql`**, despite `1_replacement-plan.md`'s sketch saying 0011.
6. **`RiskTicket` does not carry the assignee's accountId.** `mapIssue` (`refresh.ts:591`) keeps only `displayName` + avatar; the `UserField` interface doesn't even type `accountId`. Recipient routing needs it — see §6 for the small Phase-1-code touch.
7. **"N consecutive refreshes" is not a stable unit in this repo.** Refresh cadence varies 5–60+ min with viewing activity and backoff, and re-runs would double-increment a counter (breaking idempotency). The hysteresis accumulator is therefore **M continuous work-hours** (`risk_since` timestamp + the org's `WorkClock`), which recomputes identically under re-runs. `risk_streak` is kept as a diagnostic column only.

## 3. Data model — final DDL

`migrations/0012_risk_alerts.sql` (idempotent, mirrored into `worker/src/db/schema.sql` with the keep-in-sync comment, inside the existing risk block's boundary header):

```sql
-- Sprint Risk Board Phase 2: per-ticket alert hysteresis state + per-user opt-out.
-- Accessed ONLY by worker/src/risk/store.ts via env.DB — never dao.ts.
-- Mirrors worker/src/db/schema.sql.

-- One row per ticket per board *while it is in (or just out of) a risk episode*.
-- No row = armed and clean. Rows are deleted when a ticket leaves the board or
-- has been clean past the re-fire cooldown, so the table stays tiny.
CREATE TABLE IF NOT EXISTS risk_alert_state (
  cloud_id          TEXT NOT NULL,
  board_id          INTEGER NOT NULL,
  issue_key         TEXT NOT NULL,
  phase             TEXT NOT NULL DEFAULT 'armed',  -- armed | firing | recovered
  risk_since        TEXT,     -- ISO UTC: start of the current continuous at-risk run; NULL = not at risk
  risk_streak       INTEGER NOT NULL DEFAULT 0,     -- diagnostic only (tuning/observability)
  last_notified_at  TEXT,     -- ISO UTC of the last fire (NULL = fired-but-unreachable or never)
  last_payload_hash TEXT,     -- content hash of the last fired alert (adapter dedup hint + observability)
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (cloud_id, board_id, issue_key)
);

-- Per-user opt-out for struggling-ticket nudges. Risk-owned (not users/dao.ts) so
-- deletion of the feature drops it. Keyed by Atlassian account_id, same id space
-- as user_channels.
CREATE TABLE IF NOT EXISTS risk_alert_prefs (
  account_id  TEXT PRIMARY KEY,
  muted       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
```

Semantics:
- `phase='armed'` (or no row): accumulating. `phase='firing'`: latched, quiet. `phase='recovered'`: was fired, ticket got back to ok; behaves like armed but re-firing additionally requires the cooldown vs `last_notified_at`.
- `last_notified_at IS NULL` with `phase='firing'` means the transition was *consumed silently* (unassigned / no linked channel / muted) — prevents re-checking every refresh.
- GDPR: `risk_alert_state` stores no personal data (issue keys only). `risk_alert_prefs` stores an account id → `riskEraseAccount` gains one `DELETE`. Snapshots will now also embed `assigneeAccountId` (§6) — same self-healing class as the display names already documented in `riskEraseAccount`'s comment.

## 4. New module `worker/src/risk/alerts.ts` — constants + pure policy

Named exported constants, `refresh.ts`-style doc comments, conservative per arch §14:

```ts
/** Continuous work-hours at `risk` tier before a ticket's first nudge fires.
 *  8h = one full workday past the risk line (arch §9's own example). */
export const FIRE_AFTER_RISK_WORK_HOURS = 8;
/** After a recovery, a re-fire also needs this many work-hours since the last
 *  nudge — slow to re-fire (arch §14). 16h = two workdays. */
export const REFIRE_COOLDOWN_WORK_HOURS = 16;
/** Cap on tickets listed in one aggregated message ("…and k more" past this). */
export const MAX_ALERT_TICKETS = 10;
/** A recovered row older than this past cooldown is garbage-collected. */
export const RECOVERED_ROW_TTL_MS = 14 * 24 * 60 * 60_000;
```

Pure policy functions (all unit-testable without D1/fetch):

```ts
/** Tri-state alert signal from a ticket: 'risk' | 'mid' | 'ok'.
 *  'ok' = tier 'ok' OR tier null (done column / nothing scoreable) — the ONLY
 *  state that re-arms. 'mid' (warn) is the hysteresis gap: breaks at-risk
 *  continuity while armed, but does NOT clear a firing latch. */
export function alertSignal(t: RiskTicket): 'risk' | 'mid' | 'ok';

/** The hysteresis state machine, one ticket, one refresh. Pure. */
export interface AlertState {  // mirrors the row, camelCase
  phase: 'armed' | 'firing' | 'recovered';
  riskSince: string | null;
  riskStreak: number;
  lastNotifiedAt: string | null;
  lastPayloadHash: string | null;
}
export type AlertStep =
  | { action: 'none' }                      // no row existed, none needed
  | { action: 'upsert'; next: AlertState }  // accumulate / latch / recover
  | { action: 'delete' }                    // clean past TTL → drop the row
  | { action: 'fire'; next: AlertState };   // transitioned into firing THIS run
export function stepAlertState(
  prev: AlertState | null,
  signal: 'risk' | 'mid' | 'ok',
  clock: WorkClock,
  nowMs: number,
): AlertStep;

/** Quiet hours: is the org's work clock open right now? */
export function isWorkOpen(clock: WorkClock, nowMs: number): boolean;
  // implementation: clock.workMs(nowMs, nowMs + 60_000) > 0 — zero new code in workhours.ts

/** Firing metrics of one ticket in triage priority order (blocked w/ blocker
 *  keys > idle > timeInColumn > cycle > rejections; composite when it alone is
 *  at risk), each with a formatted value — mirrors the triage row. */
export interface AlertDriver { metric: RiskMetricId | 'composite'; label: string }
export function alertDrivers(t: RiskTicket): AlertDriver[];

/** Work-hours duration as "Nd Nh" on the 8h workday (worker-side twin of the
 *  client's fmtWorkHM; lives here, not shared/ — one consumer). */
export function fmtWorkHours(hours: number): string;

/** Stable FNV-1a hex hash of the alert's semantic content (issue keys + driver
 *  labels), for the adapter idempotency key + last_payload_hash. */
export function alertPayloadHash(items: Array<{ key: string; drivers: AlertDriver[] }>): string;

/** One recipient's channel-neutral message for k tickets. */
export function composeAlertPayload(
  appOrigin: string,
  boardName: string,
  items: Array<{ ticket: RiskTicket; drivers: AlertDriver[] }>,
): NotificationPayload;
```

`stepAlertState` transition table (the load-bearing rules):

| prev phase | signal | result |
|---|---|---|
| none/armed | `risk` | set `riskSince` if null, `riskStreak+1`; if `workMs(riskSince, now) >= FIRE_AFTER_RISK_WORK_HOURS * 3.6e6` → **fire candidate** (else upsert) |
| none/armed | `mid` or `ok` | clear `riskSince`/`riskStreak`; delete the row if nothing else to remember (`lastNotifiedAt` null), else upsert |
| firing | `risk` or `mid` | latched — quiet; upsert (keep streak ticking for diagnostics) |
| firing | `ok` | → `recovered`, clear `riskSince`/`riskStreak` (the clear-low threshold: only full `ok` re-arms) |
| recovered | `risk` | accumulate as armed; fire candidate additionally requires `workMs(lastNotifiedAt, now) >= REFIRE_COOLDOWN_WORK_HOURS * 3.6e6` |
| recovered | `mid`/`ok` | reset accumulator; **delete** row once `now - updatedAt > RECOVERED_ROW_TTL_MS` (GC) |

Note the fire *candidate* is not yet a fire: quiet hours and the CAS still gate it (§5). Because accrual is derived from a stored timestamp + the work clock, re-running the same refresh recomputes the identical verdict — no counter to double-apply.

Monday-storm behavior falls out for free: work-hours accrual is zero over the weekend, so nothing can newly cross the 8h threshold at Monday 09:00 that hadn't already crossed it Friday; tickets that tipped over the weekend in *calendar* terms accrue from Monday open and fire spread across the day — and same-refresh coincidences collapse into one message per person anyway.

## 5. The diff step — algorithm, CAS, ordering

### Orchestrator

```ts
export async function processBoardAlerts(
  env: Env, dao: Dao, cfg: RiskOrgConfig, board: RiskBoardRef,
  tickets: RiskTicket[], clock: WorkClock, log: Logger, nowMs: number,
): Promise<void>
```

Called from `refreshBoard` at the exact landed seam (`refresh.ts:544`), **before** `overwriteSnapshot`, wrapped so alerting can never fail the board:

```ts
// PHASE 2 seam — replaced by:
try {
  await processBoardAlerts(env, opts.dao, cfg, board, tickets, clock, log, opts.nowMs);
} catch (e) {
  log.warn('risk: alert pass failed; snapshot proceeds', { boardId: board.boardId, ...errFields(e) });
}
await overwriteSnapshot(env, cfg.cloudId, snapshot);
```

`refreshBoard` gains `dao` (and optionally `log`) via `RefreshBoardOptions` — a risk-internal signature, threaded from `refreshOrg` which already holds `dao`. Make it required (not optional) so production can't silently skip alerting; the ~4 test call sites get the real `Dao` they already construct.

### Step-by-step

1. **Load prior state**: `listAlertStates(env, cloudId, boardId)` → `Map<issueKey, AlertState>`. One query.
2. **Step every ticket** through `stepAlertState(prev, alertSignal(t), clock, nowMs)`. Collect: upserts, deletes, fire candidates. Also collect `DELETE` for every stored row whose `issue_key` is **not** in the current ticket set (departed/off-sprint tickets — their episodes end silently).
3. **Apply the non-fire writes** (upserts/deletes). Plain idempotent writes — absolute values computed from `riskSince`, never increments that could double-apply (streak is diagnostic; a double-increment there is harmless and only possible on a same-tick crash-rerun).
4. **Quiet-hours gate**: if `!isWorkOpen(clock, nowMs)`, **stop before consuming any fire candidate** — write their accumulator upserts (phase stays `armed`) and return. The transition is *held*, not dropped: the next refresh inside work hours re-derives the same candidates and fires then. This is "queue for next work-open" with zero queue machinery, and it degrades gracefully with the idle cadence (worst case: fires within ~an hour of office open). Chosen over dropping — dropping would permanently lose any tip that happens to be observed by an overnight refresh.
5. **Resolve recipients per candidate** (reads before claims — the `escalate.ts` / `notify.ts` ordering rule, so a throwing read leaves state untouched for a clean retry):
   - `t.assigneeAccountId == null` → unreachable.
   - `getAlertMuted(env, accountId)` true → unreachable (opted out).
   - `dao.getUserChannels(accountId)` empty → unreachable (assignee never linked the app; `log.info`).
6. **Claim, per ticket — the CAS** (`store.claimAlertFiring`, mirroring `claimDegradedNotice`):
   ```sql
   UPDATE risk_alert_state
      SET phase = 'firing', risk_streak = ?, last_notified_at = ?, last_payload_hash = ?, updated_at = ?
    WHERE cloud_id = ? AND board_id = ? AND issue_key = ?
      AND phase IS ?              -- the phase the caller read ('armed' | 'recovered')
      AND last_notified_at IS ?   -- the stamp the caller read
   ```
   `runChanges(res) > 0` = won. (The row always exists by claim time: an at-risk ticket got an upsert the moment `riskSince` was first set.) Exactly one concurrent tick can win; a lost claim silently drops the ticket from the send. For **unreachable** recipients, claim with `last_notified_at = NULL` — the episode is consumed (transition-only firing still holds; no per-refresh channel re-probing) but records that nothing was sent. Quiet-hours holds (step 4) deliberately do **not** claim — time-gated vs person-gated non-sends behave differently, on purpose.
7. **Aggregate per recipient**: group claim-winners by `assigneeAccountId`; per recipient build drivers, `hash = alertPayloadHash(items)`, `payload = composeAlertPayload(...)`, and deliver once via the channel loop (first `delivered` wins, `not_linked` falls through — extract `notify.ts`'s `deliverToAdmins` inner loop into an exported `deliverToAccount(env, dao, accountId, payload, idempotencyKey, log): Promise<boolean>` and reuse it from both callers). `idempotencyKey = ` `` `risk-alert:${cloudId}:${boardId}:${accountId}:${hash}` `` — the payload-hash dedupe, giving adapters a stable best-effort second line of defense if a retried tick ever re-composes the identical aggregate.
8. Log one structured line: `log.info('risk: alerts', { cloudId, boardId, fired, recipients, held, unreachable, recovered })`.
9. Return; `refreshBoard` overwrites the snapshot (arch step 6's "state before snapshot" preserved).

### Ordering / failure analysis (budget-abort and friends)

- **Budget exhaustion is between boards, never mid-board** (`refreshOrg` checks `budget.remaining` at the top of the loop; the reconcile happens after the board). So the budget can never abort between "alerts sent" and "snapshot overwritten" — a board either runs its full compute→alerts→overwrite sequence or isn't started this tick. Deferral to the next tick just re-runs the whole board later; work-hours accrual makes the later run compute equivalent-or-later state. No special handling needed.
- **429 / Jira failure**: thrown during compute, i.e. *before* the diff step — no alert state touched, no sends. Clean.
- **D1 failure inside the alert pass**: caught by the new try/catch; snapshot still overwrites, board still `recordSuccess`. Some tickets' rows may have advanced; the next refresh re-derives from `risk_since` + clock, so the outcome converges. Tickets already claimed `firing` stay latched (transition-only) — worst case one nudge was lost, never duplicated.
- **Crash after claim, before deliver** (isolate eviction): row says `firing`, `last_notified_at` stamped, message never left. Lost-not-duplicated, by design (repo-wide CAS idiom; the future digest is the eventual catch-all).
- **Crash after alerts sent, before snapshot overwrite**: the user got a nudge whose board view is one refresh stale. Harmless — the deep link opens `/risk`, which marks the board viewed, which puts it on the 5-minute active cadence; alert state is already latched so the re-run (which recomputes and overwrites) cannot re-send.
- **Re-run idempotency summarized**: latch check in the CAS (`phase IS 'armed'`) + timestamp-derived accrual (no increments) + payload-hash idempotency key at the adapter = three independent layers.
- *(UPGRADE.md Stage A note: under at-least-once queue delivery, the CAS is what makes a redelivered org message safe — this design already accounts for it.)*

## 6. Recipient resolution

The app's `users.account_id`, `user_channels.account_id`, and every adapter link table key on the **Atlassian accountId** (populated by `dao.upsertUser` from `/myself`). Jira's issue `assignee` field payload carries that same global `accountId`. So the mapping is **identity** — no join table, no name matching. What's missing is only that `mapIssue` throws the id away.

**Phase-1-code touch (justified: one field, additive, zero behavior change, zero extra Jira calls):**
- `shared/src/risk.ts`: add `assigneeAccountId: string | null` to `RiskTicket` (documented: "Atlassian account id — the recipient key for health nudges; org-visible in Jira already, so no new privacy surface").
- `worker/src/risk/refresh.ts`: `UserField` gains `accountId?: string`; `mapIssue` adds `assigneeAccountId: assigneeField?.accountId ?? null`. The `assignee` field is already requested.
- Old stored snapshots lack the field (`| null` covers them); the diff step runs on freshly computed tickets, so it's populated from the first post-deploy refresh. Client ignores it.

Skip rules (all `log.info`, silent to users): unassigned ticket; assignee with no linked channel; muted assignee. All three *consume* the transition (claim with `last_notified_at NULL`). No org-membership check is needed: an accountId with linked channels is the same human as the Jira assignee, and the content is their own ticket.

**Opt-out: include in v1.** Without it, the only escape from an unwanted nudge is unlinking channels entirely — which would also kill rating escalations, i.e. users would "mute everything", the exact failure arch §9 warns about. The existing `routes/settings.ts` pattern (users.daily_goal via dao) is the wrong host — it would put a feature column in a core table and a method in `dao.ts`, breaking deletability. Instead: `risk_alert_prefs` via `store.ts` + two self-scoped routes in `risk/routes.ts` (`GET/PUT /api/risk/alerts/prefs`, `ctx.accountId`-scoped), + a `wa-switch` in the risk board page. Wire types `RiskAlertPrefs { muted: boolean }` in `shared/src/risk.ts`.

## 7. Payload composition (mirrors the triage row)

Channel-neutral `NotificationPayload` only (contract.ts invariant — no vendor formatting):

- **Single ticket**: title `PROJ-123 looks stuck`, body `"<summary>" has been past its risk line in <column> for <fmtWorkHours> — driven by: blocked by PROJ-99 · idle 2d 1h · in Code Review 1d 3h. Worth a second pair of eyes?`
- **Aggregate (k ≥ 2)**: title `k of your tickets look stuck`, body one line per ticket (capped at `MAX_ALERT_TICKETS`, then `…and n more`): `PROJ-123 (<column>) — blocked by PROJ-99 · idle 2d 1h`.
- Drivers from `alertDrivers(t)`: metrics whose band is `risk`, in arch §11 priority order — `blocked` (with `blockedByOpen` keys inline), `idle`, `timeInColumn` ("in <column> Nd Nh"), `cycle`, `rejections`; when only the composite is at risk, `overall risk score`. Values formatted by `fmtWorkHours` (values and bands come straight off `t.metrics` — no recomputation).
- `deepLink: ${env.APP_ORIGIN}/risk` (the triage list; a per-ticket anchor is a client-side future nicety). `urgency: 'normal'` always in v1 (tone: nudge, not page; severity-based urgency is future with routing prefs).

## 8. File-by-file changes

**New files**

| File | Content |
|---|---|
| `migrations/0012_risk_alerts.sql` | DDL from §3 |
| `worker/src/risk/alerts.ts` | Constants, pure policy (§4), `processBoardAlerts` (§5), payload composition (§7). Header comment mirroring `notify.ts`'s ("second crossing of the notification seam; registry.resolve only; eslint-walled") |
| `worker/test/risk-alerts.test.ts` | See §9 |

**Touched files**

| File | Change |
|---|---|
| `worker/src/db/schema.sql` | Append the two tables inside the risk block, keep-in-sync comment for 0012 |
| `shared/src/risk.ts` | `RiskTicket.assigneeAccountId: string \| null`; `RiskAlertPrefs` + `PutRiskAlertPrefsRequest` wire types |
| `worker/src/risk/refresh.ts` | `UserField.accountId`; `mapIssue` populates `assigneeAccountId`; `RefreshBoardOptions` gains `dao: Dao` (+ pass `log`); replace the PHASE 2 comment with the try/caught `processBoardAlerts` call; `refreshOrg` threads `dao` |
| `worker/src/risk/store.ts` | `listAlertStates`, `upsertAlertState`, `deleteAlertState(s)` (incl. not-in-current-set cleanup), `claimAlertFiring` CAS, `getAlertMuted`/`setAlertMuted`; extend `deleteBoardState` (drop the board's alert rows) and `riskEraseAccount` (`DELETE FROM risk_alert_prefs WHERE account_id = ?`) |
| `worker/src/risk/notify.ts` | Extract + export `deliverToAccount` (the inner per-account channel loop of `deliverToAdmins`); no behavior change |
| `worker/src/risk/routes.ts` | `GET/PUT /api/risk/alerts/prefs` in `riskRoutes` (self-scoped; validates `muted` boolean) |
| `worker/test/risk-refresh.test.ts` | Thread `dao` into the ~4 direct `refreshBoard` calls; snapshot golden gains `assigneeAccountId` |
| `worker/test/risk-store.test.ts` | Alert-state CRUD/CAS, prefs, erase, board-removal cleanup |
| `worker/test/risk-routes.test.ts` | Prefs route wiring + validation |
| `client/src/app/risk/risk-board.component.ts` + `api.service.ts` risk block | Mute toggle (`wa-switch`) + two typed methods |
| `worker/CLAUDE.md` | Update the `src/risk/` section in the same change (repo rule: guidance never lies to the next agent) |

**Not touched**: `worker/src/index.ts` (prefs routes ride the existing `/api/risk/` prefix dispatch), `dao.ts` (reads only, existing methods: `getUserChannels`), `.eslintrc.cjs` (`worker/src/risk/**` is already in the registry-seam override), adapters, `workhours.ts` (`isWorkOpen` composes `workMs`).

Deletion story additions: the eventual drop migration also drops the two new tables; everything else is inside already-deletable paths.

## 9. Test plan

`worker/test/risk-alerts.test.ts` — two layers, mirroring `risk-notify.test.ts` (real SQL via `SqliteD1` + stubbed global fetch → Zulip DMs):

**Pure (`stepAlertState`, `alertSignal`, `alertDrivers`, `isWorkOpen`, hash/format):**
- No fire below `FIRE_AFTER_RISK_WORK_HOURS`; fire exactly at/past it; weekend contributes zero accrual (reuse the DST-safe schedule fixtures from `risk-workhours.test.ts`).
- `mid` (warn) resets an armed accumulator but does not unlatch `firing`; only `ok`/done recovers.
- Recovered → re-risk fires only past `REFIRE_COOLDOWN_WORK_HOURS`.
- Re-running the same step (same inputs) yields the same output.
- Driver ordering + blocked keys + composite-only case; hash stability.

**Integration (through `refreshBoard`/`refreshRiskBoards` with the stub client, two refreshes separated by simulated work-time):**
- Fires once on the edge; a third refresh while still at risk sends nothing (transition-only).
- Two tickets, same assignee, same refresh → exactly one fetch, body lists both (aggregation).
- Quiet hours: refresh at 02:00 with a met threshold → no send, no claim; next refresh at 09:30 → one send (held, not dropped).
- Concurrent-tick CAS: run the alert pass twice for the same computed state → one send (claim loses second time).
- Unassigned / unlinked / muted assignee → no fetch, phase latched `firing` with NULL `last_notified_at`, later refreshes don't re-probe.
- Ticket disappears from the board → row deleted; board removed from config → `deleteBoardState` clears its alert rows.
- Alert-pass D1 failure (inject a throwing statement) → board still snapshots + `recordSuccess`.
- `riskEraseAccount` wipes the erased account's prefs row.
- Deploy-day storm guard: first-ever refresh of a board deep at risk fires nothing (accrual starts at first observation).

## 10. Verification (manual, `wrangler dev` against real Jira)

1. `npm run db:migrate` (local); confirm `risk_alert_state`/`risk_alert_prefs` exist.
2. Link a Zulip/email channel for your own account; make yourself the assignee of a test ticket; temporarily lower the org's cutoffs (admin UI) so the ticket computes `risk`.
3. `POST /api/__dev/risk/refresh` once → verify **no** message (accumulating), `risk_alert_state` row with `risk_since` set.
4. Backdate `risk_since` by >8 work-hours with a local SQL edit, re-trigger → exactly one DM with the driven-by line; re-trigger again → silence.
5. Set the work schedule so "now" is closed, reset the row to armed, re-trigger → held; reopen schedule → fires.
6. Toggle the mute pref, repeat → consumed silently (check the structured log line).
7. `npm test`, `npm run typecheck`, `npm run lint`.

## 11. Rollout / tuning

- Ships dark-ish by default: conservative 8h/16h constants mean days can pass before the first fire; watch the `risk: alerts` log line's `fired/held/unreachable` counters (the same instrument-first philosophy as `jiraCalls`).
- Tune `FIRE_AFTER_RISK_WORK_HOURS` down (or add a faster lane for `blocked`) only after observing real flap rates via `risk_streak`/`updated_at` in the table.
- Kill switch: per-user mute exists in v1; org-level switch is open question #2.

## 12. Open questions (decide during build; none block starting)

1. **Defaults**: 8 work-hours to fire / 16 to re-fire acceptable? (Both single named constants.)
2. **Org-level kill switch**: should `risk_board_config` gain an `alerts_enabled` column so an admin can disable nudges org-wide before the feature earns trust? Cheap (one column + admin UI checkbox); recommended if rollout is to a real team.
3. Same ticket on two configured boards fires once per board — accept (rare) or dedupe by issue key at the org level (adds cross-board state coupling)?
4. Should `blocked`-driven fires use `urgency: 'high'`? Deferred to severity routing (future); confirm.
5. Per-user quiet hours / timezone (remote devs vs org clock) — future; confirm out of scope.
6. Recovery notes to devs and the "still struggling" digest — future phases; confirm.
