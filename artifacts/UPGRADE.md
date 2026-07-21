# UPGRADE.md — scaling the risk-board refresh to 1,000s of orgs

> **When to read this.** The current refresh engine (`worker/src/risk/refresh.ts`)
> is a budget-scheduled cron job sized for a few dozen orgs. This document is the
> pre-agreed graduation path to the queue/consumer topology of `0_arch.md` §4–§5
> if the fleet ever grows toward hundreds or thousands of orgs. It exists so that
> decision is **measured and staged**, not improvised under load. Until the
> triggers below fire, do nothing.

---

## 1. Current design and its actual ceiling

One cron tick (`refreshRiskBoards`, every 3 min) enumerates eligible boards
fleet-wide (DB-only — no Jira calls in the scheduling step), interleaves them
org-fair (`interleaveByOrg`), and refreshes serially under a per-tick
subrequest budget:

| Knob (in `refresh.ts`) | Value | Meaning |
|---|---|---|
| `TICK_SUBREQUEST_BUDGET` | 600 | Jira calls spent per tick (of the ~1,000/invocation platform cap) |
| `BOARD_COST_ESTIMATE` | 50 | pre-charge per board; reconciled against actuals |
| `ACTIVE_REFRESH_MS` / `IDLE_REFRESH_MS` | 5 min / 60 min (+ jitter) | demand-driven cadence |
| `PACING_MS` | 200 | sleep between Jira calls **within** an org |
| `BACKOFF_CAP_MS` | 6 h | failing-board retry ceiling |

Capacity ≈ `600 / 50` = **~12 board-refreshes per tick ≈ 240/hour**. At hourly
idle cadence + a handful of actively-viewed boards, that serves a few dozen
orgs with wide margin. The ceiling is the **per-invocation subrequest cap**
combined with the single serial invocation — not CPU (paced awaits are
unbilled), not D1, not the read path (which is one storage read regardless of
fleet size and never needs to scale).

**The load-bearing invariant to preserve through every stage:** all of one
org's Jira calls are serialized and paced together (Jira rate limits are
per-tenant — `0_arch.md` §5), while different orgs may proceed independently.
And snapshots are overwrite-only, so any re-run is idempotent.

## 2. Triggers (measured, not vibes)

Graduate only when the per-org instrumentation (Jira-call counts logged per
tick by `refreshOrg`) shows, sustained over days:

1. **Backlog:** eligible boards regularly not refreshed within their cadence
   (active boards going >2× `ACTIVE_REFRESH_MS` stale; idle boards >2× idle
   cadence), i.e. the eligible set per tick routinely exceeds ~12 boards; or
2. **Budget exhaustion:** most ticks stop on `TICK_SUBREQUEST_BUDGET` rather
   than running out of eligible boards; or
3. **Fairness pressure:** one mega-org's boards consume enough budget that
   interleaving alone no longer keeps other orgs on cadence.

Cheap pre-stage remedies to try first (config-level, no topology change):
lengthen `IDLE_REFRESH_MS`, shrink per-board cost by skipping unchanged issues
(compare the issue's `updated` field to the previous snapshot and reuse its
computed record — cuts the ~50-call estimate dramatically for quiet boards),
or trim `PACING_MS`. These can buy a 2–5× headroom multiple before any
infrastructure changes.

## 3. Stage A — Cloudflare Queue in the *same* Worker (the real upgrade)

The minimal change that removes the ceiling. Cloudflare Queues supports the
producer and consumer living in one Worker, so this stays a single repo, a
single deploy, and preserves the deletion story.

**What changes:**

1. **`wrangler.toml`** — add the queue and bind it:

   ```toml
   [[queues.producers]]
   queue = "risk-refresh"
   binding = "RISK_REFRESH_QUEUE"

   [[queues.consumers]]
   queue = "risk-refresh"
   max_batch_size = 2          # small batches; concurrency does the fanning (§5)
   max_batch_timeout = 5
   max_retries = 5
   dead_letter_queue = "risk-refresh-dlq"
   ```

   Plus the DLQ itself and a `Queue` binding in `worker/src/env.ts`.

2. **Split `refreshRiskBoards` at its existing seam.** The function already has
   two halves: *scheduling* (enumerate configs → `isEligible` per board →
   `interleaveByOrg`) and *execution* (`refreshOrg` per org). The split:
   - **Producer (cron, unchanged cadence):** run the scheduling half, group the
     eligible boards per org, `RISK_REFRESH_QUEUE.send({ cloudId, boardIds })`
     — **one message per org** (per-tenant rate limits are why; never
     per-board, or concurrent invocations of the same org self-inflict 429s —
     `0_arch.md` §5's core warning). The cron does zero Jira work, exactly as
     it already does.
   - **Consumer (`queue()` handler in `worker/src/index.ts`, one registration
     line):** per message, load the org config and call **`refreshOrg` with no
     tick budget** (`budget` param omitted — it's already optional). Each
     consumer invocation gets its own ~1,000-subrequest allowance, so the
     per-board cost model stops mattering fleet-wide; pacing inside the org
     still governs the org's Jira rate.
3. **Ack/retry semantics** (§5, applied): `msg.ack()` per message on success;
   on 429 or transient failure `msg.retry({ delaySeconds })` with backoff
   (replaces the tick-level backoff for queued work; keep
   `risk_board_state.failures` as the record). After `max_retries`, the message
   lands in the DLQ → mark the org degraded (`degraded_reason`) → the existing
   `notify.ts` degraded-org admin notice fires. A dead refresher token stops
   retrying and starts telling a human — same behavior as today, new transport.
4. **Double-delivery safety:** queues are at-least-once. Already handled —
   snapshots are overwrite-idempotent, and duplicate concurrent refreshes of
   the same org are merely wasteful, not incorrect. If waste matters, add a
   cheap lease (`last_attempt_at` CAS in `risk_board_state`, the
   `claimDegradedNotice` idiom) to skip a board attempted in the last minute.
   *(Phase 2 note: the alert diff step must stay behind its payload-hash CAS so
   a redelivered message cannot double-send — that CAS is required regardless.)*
5. **Token scoping:** unchanged and now actively important — the token is
   fetched inside the consumer invocation, per org, never module-global.
   Concurrent invocations are always *different* orgs (one org = one message),
   so per-tenant pacing still holds.

**Capacity after Stage A:** Cloudflare autoscales consumer concurrency with
queue depth; throughput becomes ~(concurrent invocations × boards per org)
instead of 12/tick. 1,000 orgs at hourly cadence ≈ 17 org-messages/min —
trivial queue volume (§7's cost math: ~3 ops/message, low single-digit
$/month).

**Rollback:** flip the cron back to calling the execution half directly and
remove the queue bindings. `refreshOrg` itself never changed — that was the
point of building it self-contained.

## 4. Stage B — separate consumer Worker (only if deploy isolation starts to matter)

If the consumer's failure modes or deploy cadence begin to endanger the
tracker (the risk `0_arch.md` §2 worried about), move the queue consumer to
its own Worker:

- New `worker-risk/` with its own `wrangler.toml` binding the same queue as
  consumer, the same D1 database, and a **service binding to the core Worker**
  for token access — at that point implement the arch doc's
  `getJiraToken(tenant)` contract (§2's token contract, verbatim: local-var
  caching keyed by tenant, re-ask on 401, never persist) instead of importing
  `JiraClient` directly.
- The pure logic (`worker/src/risk/logic/`) moves with the consumer or becomes
  the "shared kernel" the arch doc said to extract **only when a second
  consumer appears** — this is that moment, not before.
- Read path, routes, and UI stay in the core Worker (they're trivial and
  benefit from same-origin).

This stage is real operational cost (second deploy pipeline, binding contract
to maintain). Take it only for isolation reasons, never for throughput —
Stage A already scales throughput.

## 5. What to revisit alongside (not part of the queue mechanics)

At 1,000s of orgs these adjacent Phase-1 decisions come due — listed here so
the queue upgrade isn't mistaken for the whole job:

- **Token custody** (`1_changes-from-arch.md` deviation #3): the
  admin-designated refresher account doesn't survive contact with external
  customers — build the per-tenant OAuth install flow (`0_arch.md` §8),
  including encrypted tenant refresh-token storage (the `secretbox.ts`
  machinery already exists) and the revoked-grant → DLQ → "reconnect Jira"
  loop.
- **Noisy-neighbor instrumentation → throttling** (§7): the per-org call
  counts exist; add per-org caps/pricing before a 2,000-ticket mega-sprint
  tenant costs 50× a normal one.
- **Snapshot storage**: D1 TEXT is fine for tens of KB × thousands of rows;
  move blobs to R2 only if row sizes or D1 storage limits actually pinch
  (§14's open question — still resolved "D1 until proven otherwise").
- **Scheduler enumeration cost**: `listConfigs()` + per-board state reads are
  O(fleet) per tick in D1 — fine to ~10k boards; past that, add an indexed
  `next_due_at` column and query only due rows.

## 6. Summary

| Stage | Trigger | Change | Deploys | Throughput ceiling |
|---|---|---|---|---|
| **Now** | — | budget-scheduled cron | 1 | ~240 board-refreshes/hour |
| **Pre-A** | early backlog signs | cadence knobs + skip-unchanged-issues | 1 | ~2–5× current |
| **A** | sustained backlog/budget exhaustion | same-Worker queue producer/consumer, one msg/org, DLQ | 1 | autoscaled (1,000s of orgs) |
| **B** | deploy-isolation pressure | separate consumer Worker + `getJiraToken` service binding | 2 | same as A, isolated |

The invariants that never change across stages: one org's Jira calls are
serial and paced; snapshots are overwrite-idempotent; a permanently broken org
stops retrying and notifies a human; the feature stays deletable.
