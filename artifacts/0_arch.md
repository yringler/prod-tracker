# Sprint Risk Board — Architecture & Implementation Guide

> **Purpose of this document.** This is context for Claude Code (or any engineer)
> building a multi-tenant SaaS version of an existing single-user Jira "sprint
> risk board." It captures the target architecture, the constraints that shaped
> it, the reusable logic to port, and the decisions already made (with their
> rationale) so they don't get relitigated. Read it end-to-end before writing
> code; the sections build on each other.

---

## 1. What we're building

A hosted service that, for each connected Jira instance, watches the active
sprint(s) on one or more boards and surfaces **which tickets need attention and
why** — tickets that are stale, stuck in a column too long, blocked, churning in
code review, or slow end-to-end. The primary UI is a **risk-ranked triage list**
(worst tickets on top), not a kanban board — Jira already does boards well; the
value here is time-pressure and staleness signals Jira doesn't compute.

### Origin
This grows out of a working single-user **Tampermonkey userscript** that runs
inside a logged-in Jira tab, calls Jira's REST APIs on the user's own session
cookie, computes work-hours-aware risk timers per ticket, and renders a board.
The userscript works well but does **all computation client-side, per viewer, on
every refresh**, stores nothing centrally, and can't support multiple viewers,
history, shared dashboards, or non-browser access. This project centralizes that
computation into a service.

### Existing infrastructure to build on
- A site at `tracker.yehudardevelopment.com/tracker` (a story-point tracker with
  existing Jira integration).
- Backend is a **Cloudflare Worker with Jira OAuth**.
- On the **Workers Paid** plan ($5/mo base).

### Business model (assumed)
- ~**$5 per seat / month**.
- Target scale to reason about: **~1,000 companies** (tenants), each with a few
  boards, each board a sprint of ~15–30 in-flight tickets. So plan for
  **100k–300k tickets in flight** across the fleet — that ticket count, not the
  company count, is what actually drives load.

---

## 2. Overriding design constraint: this must be easy to delete

**The single most important non-functional requirement.** This feature is
speculative — it may be radically changed or removed within weeks. Every
structural decision is therefore judged first by: *if I delete this in two weeks,
how much surgery does my core tracker app need?* The target answer is **almost
none** — delete a directory, delete a Worker, remove one route/component. Nothing
in the core app should depend on the risk board's existence.

This is deliberately **not** "microservices." Microservices as a frame tempts you
toward separate repos, network boundaries, published packages, and versioned API
contracts — all of which add real operational cost for a solo dev and buy nothing
here. What we actually want is **physical isolation without organizational
separation**: separate Worker, own directory, its own storage, a thin service
boundary — but one repo, no published packages, no public HTTP contract to
maintain.

### The four independent decisions (don't conflate them)

| Question | Decision | Deletion impact |
|---|---|---|
| **Deployment** | Separate Worker for the risk-board backend | `wrangler delete` — one command |
| **Repo** | Naive monorepo: 2–3 `package.json`s, risk board in its own directory. **No Nx.** | `rm -rf` the directory |
| **Frontend** | Iframe (leaning) or lazy-loaded Angular route | Remove one component / one router line |
| **Shared code** | **None yet.** Extract only when a 2nd consumer appears | Nothing to extract if boundary held |

- **Separate Worker (clear yes).** Different workload (its own cron, queue
  consumer, storage, failure modes). Co-deploying into the core Worker means a bad
  queue-consumer deploy can take down the tracker. Separate = isolated by default,
  deletable by deletion. Cross-Worker calls are cheap on Cloudflare (service
  bindings).
- **Naive monorepo (not Nx).** Two `package.json`s. The monorepo is what makes
  deletion *clean* (shared code is trivially reachable while it lives, gone when
  the directory goes). A separate repo would make sharing harder and add a
  versioning problem. Resist splitting repos.
- **Frontend — lean iframe** given the uncertainty. It's the most disposable
  option, and the postMessage host↔iframe pattern is **already solved** in the
  userscript (reuse it as a template). Same-domain path routing means cookies/auth
  carry over. If the feature proves itself and iframe friction annoys, promoting
  to a lazy Angular route later is a contained refactor. A standalone Angular
  *library* is over-packaging for something that might be deleted — skip unless
  the tracker becomes multi-app.
- **No shared kernel until a real second consumer exists (YAGNI).** The pure risk
  functions are consumed *only* by the risk board → they're the risk board's code,
  not shared code. Let duplication tell you when to extract, never speculatively.

### Service boundary: core is the auth manager

The one thing the two Workers genuinely share is **Jira auth**, and the core app
**already owns Jira OAuth** (tokens, refresh, the Atlassian app registration).
So: **core stays the sole authority over token lifecycle; the risk board is a
pure consumer that asks core for tokens.** The risk board never touches Jira's
OAuth surface and never stores a refresh token — so deleting it unpicks no auth
state.

**Transport: Cloudflare service binding (Worker-to-Worker, in-process, no public
HTTP).** Core exposes a method; the risk board calls it like a function. No
network hop, no public endpoint to secure, no extra request billing (one request
for the entry Worker + combined CPU). This gives the service *boundary* (a typed
contract) without the operational cost of a real network service.

**Data ownership (the "no shared DB" rule, applied correctly):** core owns token
state; the risk board owns snapshot state. **Neither reads the other's tables.**
The rule is *"don't let two services write the same table or depend on each
other's schema,"* not *"never colocate data."* If the risk board later needs
something core has (e.g. the tenant's board list), **core exposes it over the
binding** — the risk board does not reach into core's DB. Apply this consistently
through the binding and the two stay severable.

### The token contract

Decision: **core returns a token; the risk board makes its own Jira calls.** Not
`core.jiraFetch(...)`. Rationale: the risk board's whole value is its paced,
rate-limit-aware call cadence (see §5–§6); routing thousands of paced changelog
fetches through core would make core a bottleneck and force core to know the risk
board's pacing needs. So the boundary is: **core owns token *lifecycle*; the risk
board owns token *use*.**

```
// core exposes, over a service binding:
getJiraToken(tenantId): { accessToken, cloudId, expiresAt }
   - core handles refresh, storage, the OAuth dance
   - cheap + idempotent to call repeatedly; may return a cached-but-valid token
   - risk board treats the token as opaque

// risk board consumer:
   - on invocation start:  token = await core.getJiraToken(tenant)   // LOCAL var
   - use it for all of THIS tenant's paced calls
   - on any 401:           token = await core.getJiraToken(tenant); retry once
   - NEVER store the token in module scope; NEVER persist it
```

**Token-scoping is the one real bug-risk — get it right:**
- **Never cache the token in a module-global.** Workers reuse an isolate across
  invocations, so a module-level variable can outlive the request and be visible
  to the *next* invocation — which, multi-tenant, may be **a different tenant**. A
  bare module global = a cross-tenant token-leak bug. **Cache only in a local (or
  a Map created inside the handler), keyed by tenant, scoped to the invocation.**
- **Handle mid-run expiry via 401, not clock prediction.** Access tokens last
  ~1h; a single company's paced run normally fits inside that. But a huge tenant
  or heavy 429 backoff could cross expiry. Don't predict — on a **401**, re-ask
  core once (core refreshes under the hood) and retry the single failed call.

> This keeps core the single source of truth for token lifecycle, keeps the risk
> board in control of its own pacing, keeps tokens scoped (no cross-tenant leak),
> and handles long-invocation expiry without either side predicting clocks.

### Core also owns preferences and notification delivery

Core already runs the notifiers (email, Zulip, web push) and owns user data
(including notification preferences). Same pattern as tokens — core exposes,
risk board consumes:

```
getUserPrefs(userId | tenantId): { notify: { channels, quietHours, severityRouting, … }, … }
sendToNotifiers(recipient, payload): void   // core owns channel routing + delivery
```

The risk board decides *what* is worth saying and *to whom* (its alerting logic,
§9); core decides *how* it's delivered. Deleting the risk board removes a caller,
not any notification infrastructure — the "easy to delete" property holds. The
risk board never learns how email/Zulip/web push actually work.

---

## 3. Core principle: separate the slow write path from the fast read path

This is the single most important architectural idea. Everything else follows
from it.

- **Write path (slow, expensive, paced):** fetching each ticket's changelog +
  dev-status from Jira, walking it, computing risk timers. This is I/O-bound,
  rate-limited by Jira, and must not happen on a user's request.
- **Read path (fast, cheap, instant):** the user opens the triage list → we
  return a **pre-computed snapshot** from our own storage. Zero Jira calls, no
  timer math, renders immediately.

The write path runs on a schedule (and on-demand for actively-viewed boards),
computes a fresh snapshot per board, and **overwrites** the stored snapshot. The
read path only ever reads that snapshot.

> The userscript conflates these — it recomputes everything on every view. The
> whole point of the service is to break them apart so read is O(1) and compute
> cost scales with *actual usage*, not with viewer count.

---

## 4. Topology

```
                    ┌─────────────────────────────────────────────┐
                    │  Scheduler Worker (Cron Trigger)             │
                    │  - decides which TENANTS are due for refresh │
                    │  - does NO Jira work itself                  │
                    │  - enqueues one message PER COMPANY          │
                    └───────────────────┬─────────────────────────┘
                                        │ enqueue (1 msg / company)
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  Cloudflare Queue  (+ Dead Letter Queue)     │
                    └───────────────────┬─────────────────────────┘
                                        │ small batches, N concurrent
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  Consumer Worker (Queue Consumer)            │
                    │  for each company message:                   │
                    │    - refresh OAuth token if needed           │
                    │    - loop the company's boards SERIALLY      │
                    │      with paced Jira calls (respect limits)  │
                    │    - run pure timer/risk functions           │
                    │    - OVERWRITE each board snapshot in storage │
                    │    - ack per message; retry on 429/transient │
                    └───────────────────┬─────────────────────────┘
                                        │ write snapshot
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  Storage: D1 (snapshots + tenant/usage state) │
                    │           and/or R2 (large opaque blobs)     │
                    └───────────────────┬─────────────────────────┘
                                        │ read snapshot
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  Read-path Worker  (user-facing API)         │
                    │  GET /tracker/risk?board=…                   │
                    │    - one storage read → return snapshot      │
                    │    - signals "this board is being viewed" to │
                    │      bump its refresh priority               │
                    └─────────────────────────────────────────────┘
```

### Why these pieces
- **Scheduler does no Jira work** — it just enumerates due tenants and enqueues.
  Keeps it fast, bounded, and cheap. Stagger/jitter which tenants are "due" so
  you don't enqueue all 1,000 on the same tick (thundering herd against Jira and
  against your own queue).
- **Queue, not one big cron loop** — spreads the fleet-wide slog across many
  small invocations with retries, backpressure, and a DLQ for free. A single
  cron invocation cannot fetch 300k tickets' changelogs.
- **Consumer is one Worker, autoscaled** — see §5 for the batching/concurrency
  mechanics, which are subtle.
- **Read path is a separate Worker** — trivially fast, scale-to-zero, no Jira.

---

## 5. Queue mechanics (read this carefully — it's the easy-to-get-wrong part)

**There is not a "listener per message."** Cloudflare Queues has **one consumer
Worker** bound to the queue. The platform invokes it with **batches** of messages
and runs **multiple invocations concurrently** up to a concurrency cap. You write
one handler that processes a batch; Cloudflare fans out.

### Decision: message granularity = one message PER COMPANY (tenant), not per board
This is deliberate and load-bearing. Reasoning:

- Jira rate limits are **per-tenant** (per Atlassian instance / per OAuth app on
  that instance), shared across all of that company's boards.
- If messages were per-board, Cloudflare could run several of *the same company's*
  boards concurrently in separate invocations. Each invocation is individually
  "well-behaved" with its pacing sleeps, but collectively they hammer that one
  company's Jira instance and eat **429s** — because the invocations don't know
  about each other.
- With **one message per company**, all of that tenant's Jira calls happen in a
  single invocation, so `await sleep()` pacing inside the loop actually controls
  that tenant's request rate. Concurrency across *different* companies is fine —
  independent rate limits.

So: **one message = one company. Inside it, loop that company's boards serially
with paced Jira calls.** Concurrency happens across companies, handled by the
platform.

### Decision: small batches, let concurrency do the fanning
- Set `max_batch_size` **low** (1–3). Each invocation owns a few companies.
- Let Cloudflare autoscale the number of concurrent invocations based on queue
  depth.
- Rationale: per-company work is a paced slog. Jamming 10 companies into one
  invocation processed serially balloons that invocation's **wall-clock** and
  risks tripping the batch timeout → redelivery storm. Small batches keep each
  invocation short in wall-clock.

### Ack semantics
- **Ack per message as it succeeds** (`msg.ack()`), not only at end-of-batch. One
  failing company must not force the whole batch to retry and re-do companies that
  already succeeded (wasteful Jira calls + duplicate work).

### Retries + idempotency + DLQ
- On Jira **429** or transient error → `msg.retry({ delaySeconds })` with backoff.
- The handler **must be idempotent**: re-running a company's refresh just
  recomputes and **overwrites** the snapshot — never double-applies anything.
  The "compute fresh snapshot → overwrite" model is naturally idempotent; keep it
  that way.
- Attach a **Dead Letter Queue**. A permanently broken tenant (revoked/expired
  token that can't refresh) must not retry forever. After N failures it lands in
  the DLQ → surface "reconnect Jira" to that tenant instead of silently burning
  retries.

---

## 6. Refresh strategy: demand-driven, not blanket

**Do not refresh every board every 5 minutes just because you can afford it.**
Two reasons, one of which money cannot fix:

1. **Jira's rate limits are Atlassian's to enforce, not something revenue buys
   out of.** Polling 1,000 tenants every 5 min gets *their* Jira instances
   throttling *your* app and annoys their Jira admins. This is the real ceiling.
   Refresh cadence must be set by "what won't get us throttled / won't annoy the
   customer," not "what I can afford."
2. Cost scales with usage instead of tenant count (nice, but secondary).

### The model
- **Actively-viewed boards:** refresh aggressively (or push-refresh on view).
  The read-path Worker signals "someone is looking at this board" back to the
  scheduler/tenant-state so its refresh priority is bumped.
- **Idle boards:** fall back to a slow cadence (or refresh lazily on next access).
- **Cadence as a pricing lever:** e.g. base $5/seat tier gets ~15-min freshness;
  a premium tier gets near-real-time. Refresh frequency becomes a monetizable
  axis, not just a cost you absorb.

### State machine (per board)
```
        first view / connect
             │
             ▼
        ┌─────────┐   viewed recently    ┌──────────┐
        │  ACTIVE │◀─────────────────────│  IDLE    │
        │ (fast)  │                       │ (slow)   │
        └────┬────┘   no view for T ─────▶└────┬─────┘
             │                                  │
             │ token dead / repeated failures   │ no view for T2
             ▼                                  ▼
        ┌──────────┐                       ┌──────────┐
        │ DEGRADED │                       │ DORMANT  │
        │ (DLQ,    │                       │ (refresh │
        │  notify) │                       │ on access│
        └──────────┘                       │  only)   │
                                           └──────────┘
```
- Track **last-viewed timestamp per board** (set by the read path).
- Scheduler enumerates "due" boards using these states + jitter.
- `T`, `T2`, and the fast/slow intervals are config knobs; pick defaults like
  ACTIVE = refresh every 5–15 min while viewed in the last ~30 min, IDLE = every
  hour, DORMANT = on-access only. Tune against real usage.

---

## 7. Cost model (so decisions are grounded, not vibes)

All figures are order-of-magnitude, worst-case (1,000 companies, aggressive
cadence), to prove the meters. Verify against live Cloudflare pricing before
relying on exact numbers — pricing drifts.

- **CPU time is a non-issue.** The workload is I/O-bound; compute per ticket is
  low-single-digit ms. Cloudflare bills Workers for **CPU time, not wall-clock**,
  and **does not bill for time spent `await`ing** subrequests. Even a consumer
  that sits for many wall-clock minutes paced against Jira burns almost no
  CPU-ms. The 15-minute cron/queue-consumer ceiling is **CPU time**, effectively
  impossible to hit doing paced I/O.
- **Subrequests are free to make and generous** (1,000 per invocation on paid;
  Cloudflare does not bill for subrequests). Per-company batching keeps you well
  under the per-invocation cap.
- **Queue operations is the meter that actually moves.** ~3 ops per message
  (write + read + delete), +1 read per retry. Worst case ~26M ops/month →
  ~**$10/month** after the 1M included. Trivial against per-seat revenue.
  Staggering cadence (§6) cuts it further.
- **Storage (D1/R2)** for snapshots is small opaque JSON per board; cheap.
- **The lever that matters is Jira rate limits + per-tenant fairness, not
  dollars.** Instrument per-tenant Jira-call + compute counts from day one (cheap
  now, painful to retrofit) so you can see the cost distribution and
  throttle/price the outlier tenant with a 2,000-ticket mega-sprint who costs 50×
  a normal tenant while paying the same.

### Why not a container (DigitalOcean droplet or Cloudflare Containers)?
Considered and rejected for the default path:
- The slog is **mostly paced waiting** on a rate-limited API. On Workers/Queues,
  **waiting is unbilled** (CPU-billed). On any container (DO *or* Cloudflare
  Containers), the process is billed for **wall-clock while active**, so the
  pacing sleeps that are *free* on Queues become *billed* on a container.
- A container's advantage is a simpler "just loop with pauses" programming model
  and keeping libraries in memory — worth it for **CPU-heavy sustained** work.
  That is **not** this workload.
- Reach for **Cloudflare Containers** (co-located with Workers, shares
  R2/D1/Queue bindings — no second vendor) only if the Workers runtime bites: a
  Node dep that won't run on `workerd`, needing a real filesystem or long-lived
  TCP, or the paced-consumer code gets gnarlier than a plain loop.
- Reach for **DigitalOcean** only to deliberately leave Cloudflare.

**Default: do the slog as a paced Queue Consumer. No container.**

---

## 8. Multi-tenant OAuth & data custody

Centralizing means you're now custodian of every tenant's Jira data and tokens.
The userscript never touched this (data stayed in the user's browser); the
service must take it seriously.

- **Per-tenant OAuth (Jira 3LO).** Each company authorizes the app once; store
  **their** refresh token, **encrypted at rest** (encryption key as a Worker
  secret; token in D1/KV). Access tokens are short-lived — refresh them **in the
  consumer** before a run so the read/compute path never hits an expired-token
  branch.
- **Token lifecycle is a real subsystem:** refresh, revocation, expiry, a company
  uninstalling/reconnecting. Handle the "refresh failed permanently" case → mark
  tenant DEGRADED → DLQ → notify to reconnect.
- **Rate-limit handling per tenant:** respect per-tenant budgets, back off on
  429s, jitter refresh phase so you don't hit every tenant at `:00`/`:05`.
- **Noisy-neighbor isolation:** one tenant's huge sprint must not starve others'
  refreshes. Per-company messages + serial in-message processing already isolate
  this well; add per-tenant concurrency caps only if needed.
- **Data isolation / compliance surface:** tenant data separation you can prove,
  encryption at rest, a privacy policy, likely SOC2 questions from larger
  customers eventually. Design storage with a hard tenant boundary (tenant id on
  every row / key prefix) from the start.

> **Verify early:** confirm that Jira **dev-status / PR data** is actually
> returned via your OAuth scopes on a real customer instance. The userscript gets
> it "for free" same-origin from an undocumented endpoint
> (`/rest/dev-status/latest/issue/detail`); via OAuth on `api.atlassian.com` the
> surface differs and coverage depends on how the Bitbucket/DevOps integration is
> wired per instance. If it doesn't return PRs, drop the PR feature rather than
> faking it — and you can then refresh more tickets per run.

---

## 9. Health-change notifications (proactive nudges)

Because we track health over time, the service can proactively tell a dev when a
ticket **tips into struggling** — a nudge to consider getting help — rather than
only showing it in the list when they happen to look. Delivery reuses core
(§2: `sendToNotifiers`, `getUserPrefs`); the hard part lives in the risk board.

### The core danger: don't cry wolf

**This is not a thin wrapper over the band function.** Naively firing when a
ticket's band goes `warn`→`risk` will make the feature harmful within a week and
get it muted, because the raw metrics are noisy *exactly at the thresholds*, and
our own data model makes it worse:

- Refresh runs every few minutes; a ticket parked **at** a cutoff flaps
  `warn`↔`risk` as work-hours tick past it → a notification every refresh.
- The **composite** is a power-mean of several noisy inputs, so it crosses its
  risk line and returns more often than any single metric.
- **Work-hours math creates artificial edges** — a ticket fine at 5:59pm Friday
  is "more idle" at 9:01am Monday only because the clock resumed. Naive firing =
  a Monday-morning alert storm that's really just the weekend ending.

So the notification layer is a **debounced, stateful, per-ticket alert state
machine** on top of the snapshots. Rules that keep it humane:

- **Hysteresis, not a single threshold.** Fire when a ticket has been `risk` for
  *N consecutive refreshes* (or *M continuous work-hours*); only re-arm once it
  drops back to `ok` — **not** merely below the risk line. The gap between the
  fire-high and clear-low thresholds is what stops flapping. Single most important
  rule.
- **Notify on the transition, once — then go quiet.** "CHABADORG-4440 has been
  past its risk line in Code Review 2 for a full day" is sent once on the edge
  into struggling, not every 5 minutes while it stays there. "Still struggling"
  belongs in a digest, not the real-time channel.
- **Respect quiet hours / work-hours.** Reuse the work-hours clock (§10).
  Don't page at 2am — queue for the next work-hour boundary or route to the
  digest. Quiet-hours prefs gate the *real-time* channels; the digest is exempt.
- **Aggregate at the human, not the ticket.** Five of my tickets tipping in one
  refresh (common post-weekend) = one "you have 5 tickets needing attention"
  message, batched per-recipient per-refresh — not five pings.
- **Severity → channel mapping is a preference.** "Blocked" might warrant a
  real-time Zulip DM; "cycle drifting" might only ever belong in the weekly
  digest. `getUserPrefs` supplies the routing so the dev tunes their own
  signal-to-noise — the thing that keeps them from muting everything.

### Alert granularity: ticket-level alert, metric-level payload

**Decision:** the alert fires at the **ticket level** (using the composite /
worst band) — one nudge per ticket, not one per metric. The **payload carries the
metric-level detail** for *why*: "struggling — driven by: idle 2d, in Code Review
2 for 1d." One alert, but it says what's wrong. This mirrors the triage-list row
design (§11) exactly — ticket-level signal, firing reasons as detail.

### Tone & routing (this is a *health* feature — get it right)

Framed *to the dev*, **private by default**, as "this one looks stuck — worth a
second pair of eyes?" — never broadcast to a manager channel as "your ticket is
late." Who receives an alert (assignee? implementor? a lead? a shared channel?)
is a real interpersonal decision: make it a **pref with a private-to-the-dev
default**, not a hardcoded post to `#standup`. Getting this wrong turns a helpful
nudge into surveillance people resent and route around.

### New state this requires (a real data-model addition)

Snapshots are stateless (recomputed + overwritten each run). Alerting needs
**history**, so the risk board gains a small **per-ticket alert-state table**,
keyed by `tenant + ticket`:

```
alert_state(tenant, ticketKey):
  phase:          armed | firing | recovered   // hysteresis state
  riskStreak:     int                          // consecutive refreshes at risk
  lastNotifiedAt: timestamp | null
  lastPayloadHash:string | null                // dedupe identical re-sends
```

### Write path grows a diff step

After computing the fresh snapshot, **before overwriting it**, the consumer:

1. Loads prior `alert_state` for the board's tickets.
2. For each ticket, updates `riskStreak` / `phase` under the hysteresis rules.
3. Collects tickets that *transitioned into* firing this run.
4. Gates them by quiet-hours + severity→channel prefs (`getUserPrefs`).
5. Aggregates per recipient → one `sendToNotifiers` call each.
6. Writes updated `alert_state`, then overwrites the snapshot.

Still **idempotent**: re-running produces the same phase transitions and the
`lastPayloadHash` dedupe prevents a retry from double-sending. The snapshot itself
is still overwrite-only.

> **Deletion story intact:** all alert logic + the alert-state table live in the
> risk board. Deleting the risk board deletes them; core's notifiers and prefs are
> untouched.

---

## 10. The risk-computation logic to port (the reusable core)

The userscript's **pure, dependency-free functions** are the crown jewels and
port to the Worker **essentially unchanged** — they take plain data and return
plain data. Port these; discard everything around them (the iframe /
postMessage / localStorage-prefs bridge exists only because the script had no
server — you have one).

### Functions to port (names from the userscript)
- **Work-hours clock:** `rbWorkMs`, plus the America/New_York timezone helpers
  (`rbNyParts`, `rbOffsetMs`, `rbNyWallToUtc`) and the `RB_WORK` schedule.
  Work hours are **Mon–Thu 09:00–18:00, Fri 09:00–13:00, America/New_York.**
  All metrics are measured in **work-hours only**, not calendar time. (There's a
  duplicate copy of this same algorithm in the flow-rendering code — `flowWorkMs`
  etc.; consolidate to one implementation server-side.)
- **Timer reduction:** `rbReduceTimers` → produces `idleHours`,
  `timeInColumnHours`, `cycleHours`, and `started` from a ticket's changelog.
- **Segment builder:** `rbBuildSegments` → per-column totals + a flow timeline
  (column segments, assignee segments) for the detail view.
- **Risk cutoffs:** `resolveCutoff` + the `riskCutoffs` tables (`idle`, `cycle`,
  `timeInColumn`) and `sizeBucket` (Fibonacci story-point buckets:
  1,2,3,5,8,13,20). Rules are matched **most-specific-first** (column+size beats
  column-only beats size-only beats default), independent of table order.
- **Composite score:** `compositeScore` — a **weighted power-mean** of the other
  enabled metrics' per-metric scores (each score = value / risk-threshold, so
  1.0 = "at the risk line"). Config: power `p` (default 2 — higher p lets the
  worst metric dominate) and per-metric `weights`.
- The `HEALTH` metric registry semantics: each metric has `score → 0..1 risk`
  (null = no data, excluded from composite), a band (`ok`/`warn`/`risk`/`none`),
  and a display format.

### Key domain rules baked into that logic (preserve them)
- **"Done" is the board's LAST column, by position** — not Jira's status-category
  flag. A column named "Done" may hold statuses Jira hasn't marked done but which
  are finished *on this board*.
- **Time in Done never counts** toward any metric. But **Done is a PAUSE, not a
  stop**: if a ticket is pulled back out of Done into a working column, the clocks
  resume (only the Done interval is excluded). A ticket currently in Done is
  frozen at the moment it last entered Done.
- **Timers start at first entry into "In Progress."** Before that, a ticket is
  "not started" and idle/in-column/cycle are null (not zero).
- **Idle ("last movement")** resets on either a status change **or** an assignee
  change.
- **Done-column tickets never register a warn/risk band** on any metric (excluded
  from scoring, sorting weight, tier, and driver counts) — but their raw values
  still display ("keep showing, stop flagging").
- **Blocked** = the Jira "flagged" field is set **OR** the ticket has an open
  inward "Blocks" link (blocker not in a done category / done column).

### Data shape per ticket (target snapshot record)
Roughly what `rbMapIssue` produces — adapt field names as you like, but the
snapshot per board should contain, per ticket:
`key, summary, type, status, column, assignee (+ avatar), points, parentKey,
implementor, codeReviewer, rejections, blocked, blockedByOpen[], idleHours,
timeInColumnHours, cycleHours, started, columnTotals[], flow{…}, recentUpdaters[],
prs[] (optional, only if dev-status works)`.
Plus board-level: `columns[]` (ordered), and the `riskCutoffs` + `composite`
config in effect.

> `recentUpdaters` = display names of anyone who changed the ticket in the last
> 24h (from the changelog). The userscript added it for a "hide old work" scrum
> filter. Keep it if you want that feature; it's cheap to compute during the walk.

---

## 11. The UI: a risk-ranked triage list (not a board)

The default view is a **single list, sorted by composite risk, worst on top.**
The length of the list *is* the health signal — a quiet sprint is a short list.

### Row anatomy (in reading order)
1. **Which ticket** — key + title + current column (small pill).
2. **Why flagged** — only the metrics currently **firing** (warn/risk), as small
   colored pills, e.g. `blocked · 4501`, `idle 5d 2h`, `in column 4d 1h`,
   `2 rejections`. A healthy ticket shows nothing here but "healthy".
3. **Whose** — assignee avatar (initials fallback).
- **Left border / stripe** encodes the ticket's overall tier
  (risk = red, warn = amber, ok = neutral/none). Scan the left edge, stop when it
  goes neutral. Healthy rows fade (lower opacity).

### What the row deliberately omits (vs. the userscript's board)
- No composite score number per row (it's the sort key, not per-row reading).
- No metric unless it's firing.
- No flow SVG, no six-chip health strip, no per-column bars.

The userscript shows all of that because it's trying to be a full board; a triage
list only needs the exception signal.

### Metric priority (which to show first when several fire)
Ranked by actionability:
1. **Blocked** (binary, highest signal; show blocker keys inline)
2. **Idle / last movement** ("nothing's happened in N work-days")
3. **Time in column** ("stuck in Code Review 2 for 3d" → points at *where*)
4. **Cycle time** (context, less immediately actionable)
5. **Rejections** (quality flag, rarely urgent)

### Detail view (on click) — this is where the rest lives
Port the userscript's modal mostly as-is; it's genuinely good. The only change is
*when* it appears (on demand, not always). It contains:
- Full metric rundown with each ticket's **own resolved warn/risk thresholds**.
- **Per-column time bar** (how long in each column, colored by that column's own
  band) — the fastest "where did the time go?" answer.
- **Linked PRs** (only if dev-status works — see §8).
- **Flow timeline** — the full vertical journey SVG (idle-gradient line, assignee
  avatars, column lanes, work-hours axis). Overbuilt for daily use, great for
  drill-in. Port `buildFlowGeometry` (it's pure) and its renderer.

### Summary chips (optional, above the list)
`N at risk · N warning · N healthy` — the tier counts, from `tierCounts` logic.

### Fit into the existing tracker
Make this a **view within** `tracker.yehudardevelopment.com/tracker`, not a
parallel app — it already has Jira integration and a dark theme. Match its
existing visual language.

---

## 12. Build order (suggested)

1. **Storage schema first** — tenants, per-board snapshots, per-board refresh
   state (last-viewed, tier, failure count), per-tenant usage counters. Hard
   tenant boundary on everything.
2. **Port the pure risk functions** (§10) with unit tests. They have zero
   dependencies and are the highest-value, lowest-risk thing to move. The
   userscript already had test markers (`//SCRUM_ENGINE_START`,
   `//FLOW_GEOM_START`, `//DEV_FILTER_START`) around the testable bits.
3. **OAuth + token storage** (§8). Verify dev-status/PR availability on a real
   instance here.
4. **Consumer Worker** — single-board refresh end-to-end for one tenant:
   fetch → walk → compute → overwrite snapshot. Idempotent.
5. **Queue + scheduler** — per-company messages, small batches, DLQ, ack-per-msg,
   retry/backoff. Start with a dumb "refresh all active every N min" scheduler.
6. **Read-path Worker** — `GET /tracker/risk?board=…` → snapshot. Sets
   last-viewed.
7. **Triage-list UI** (§11), then the detail modal.
8. **Demand-driven scheduler** (§6) — upgrade the dumb scheduler to the
   active/idle/dormant state machine driven by last-viewed.
9. **Health-change notifications** (§9) — alert-state table, hysteresis diff in
   the write path, `getUserPrefs`/`sendToNotifiers` over the binding. Build only
   after the snapshot write path is solid; it hangs off the diff step.
10. **Per-tenant usage instrumentation** + outlier throttling.

Steps 1–2 are pure and testable with no Cloudflare or Jira dependency — do them
first and get them right; everything else is plumbing around them.

---

## 13. Decisions already made (don't relitigate without new information)

| Decision | Choice | Why |
|---|---|---|
| Top constraint | **Easy to delete** — physical isolation, no org separation | Feature is speculative; may be removed in weeks |
| Deployment | Separate Worker (not co-deployed into core) | Isolation; `wrangler delete` to remove |
| Repo | Naive monorepo, own directory, **no Nx** | Clean sharing while alive, `rm -rf` to remove |
| Frontend | Iframe (leaning), reuse userscript postMessage pattern | Most disposable; auth carries over same-domain |
| Shared kernel | None until a 2nd consumer exists (YAGNI) | Risk logic has only one consumer |
| Auth | Core is auth manager; risk board asks for tokens | Core already owns OAuth; deleting risk board unpicks no auth |
| Worker↔Worker | Cloudflare **service binding**, in-process, no public HTTP | Boundary without network/ops cost |
| Token contract | Core returns token; risk board makes its own Jira calls | Risk board owns pacing; core not a per-call bottleneck |
| Token caching | Local var keyed by tenant, invocation-scoped; refresh on 401 | Module globals leak tokens across tenants |
| Cross-service data | No shared DB; expose over the binding | Each service owns its schema |
| Read vs write path | Separate; read serves pre-computed snapshots | Read must be O(1), no Jira calls |
| Notifications | Reuse core's notifiers + prefs over the binding | Core already delivers; risk board decides what/whom |
| Alert firing | Hysteresis + transition-only, ticket-level | Naive band-edge firing flaps and gets muted |
| Alert payload | Metric-level detail inside a ticket-level alert | One nudge, but says why (mirrors triage row) |
| Alert tone/routing | Private-to-dev default, "get help" framing | A health nudge, not manager-facing surveillance |
| Slog runtime | Paced **Queue Consumer**, no container | Waiting is unbilled on Workers; container bills wall-clock |
| Message granularity | **One per company**, boards serial inside | Jira rate limits are per-tenant; prevents self-inflicted 429s |
| Batch size | Small (1–3), concurrency does fanning | Keeps per-invocation wall-clock short |
| Ack | Per message | One failure shouldn't re-do the batch |
| Failure handling | Retry+backoff → DLQ → notify | Don't retry a dead token forever |
| Snapshot writes | Overwrite (idempotent) | Safe under retries |
| Refresh cadence | Demand-driven (active/idle/dormant) | Jira limits + fairness, not affordability, are the ceiling |
| "Done" definition | Board's last column, by position | Matches how the board is actually used |
| Timer basis | Work-hours only (Mon–Thu 9–18, Fri 9–13, NY) | Ported from userscript; matches team reality |
| Pure logic | Port unchanged from userscript | Dependency-free, already correct, tested |
| UI | Risk-ranked triage list, detail on click | Jira does boards; value is the exception signal |

---

## 14. Open questions to resolve during build

- **Does OAuth expose dev-status/PR data on real customer instances?** Determines
  whether the PR feature ships. Test before building it.
- **Typical active-sprint ticket count per board?** If ~15–20, some shortcuts
  open up; if 30+, the paced design is essential.
- **D1 vs R2 for snapshots?** D1 if you want to query across snapshots
  (cross-board rollups, fleet dashboards); R2 if snapshots stay opaque
  fetch-whole blobs. Can start with D1 for queryability.
- **Sprint history / trends?** The userscript removed its History/Trends views.
  Centralized storage makes historical snapshots feasible (store dated snapshots
  instead of only overwriting) — a natural premium feature, but out of scope for
  v1.
- **Refresh-cadence tiers** — what freshness does base $5/seat get vs. premium?
  A pricing decision, but it shapes the scheduler config.
- **Who receives a struggling-ticket alert by default, and can a team override
  it?** Assignee-only private is the safe default (§9), but some teams may *want*
  a shared channel or lead visibility. Make it a pref; decide the default and
  whether it's tenant- or user-level.
- **Hysteresis tuning** — the fire-high `N refreshes` / `M work-hours` and the
  clear-low threshold are guesses until real data exists. Ship conservative
  (slow to fire, slow to re-fire) and tighten once you see real flap rates.
