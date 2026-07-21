# Plan: a learnable Risk-cutoffs editor

Replaces the raw-JSON "Risk cutoffs" textarea on `/risk/admin` with a real UI.

## 0. Guiding decisions (trade-offs, up front)

1. **Storage shape does not change.** `cutoffs_json` keeps holding exactly `RiskCutoffs`.
   `resolveCutoff`, `refresh.ts`, `store.ts` persistence, and every snapshot stay untouched.
   The editor is a *projection* over that shape. This keeps the feature deletable and keeps
   the blast radius off the scoring path.
2. **One implementation of resolution, shared by both sides.** Move `FIB_BUCKETS`,
   `sizeBucket`, and `resolveCutoff` from `worker/src/risk/logic/scoring.ts` into a new pure
   `shared/src/risk-cutoffs.ts`; `scoring.ts` re-exports them so no existing worker import or
   test changes. The editor's "which rule wins" preview then *cannot* drift from the server.
   - This bends two documented rules: `shared/CLAUDE.md` says `risk.ts` is wire types only and
     the board's logic "has exactly one consumer"; `client/CLAUDE.md` says "No risk math happens
     client-side". Both were written for the *snapshot read path*, which is unaffected — the
     snapshot still ships every computed ticket value. Update both `CLAUDE.md`s in the same
     change and state the narrowed rule: *no scoring of ticket data client-side; config-editing
     math is shared.*
   - Alternative considered: a server `POST /api/admin/risk/resolve` preview endpoint. Rejected
     for the interactive preview (a round-trip per keystroke) but kept as the mechanism for the
     *impact* preview in §7, which needs snapshot data anyway.
3. **The editor is the source of truth once loaded; JSON is import/export, not a live mirror.**
   Two-way live binding between a table and a textarea is a classic drift bug. Power users get:
   an always-current read-only JSON view with `<wa-copy-button>`, plus an "Import JSON…" dialog
   that parses → validates → loads the table (or refuses with reasons).
4. **Errors block the save server-side; warnings are advisory and client-side.** Every
   currently-unvalidated footgun becomes one or the other explicitly (table in §3).
5. **Cutoffs are org-wide, but columns are per-board.** Call this out loudly in the UI (and in
   `DEFERRED.md`): if two configured boards have different column names, a `column:` rule
   silently applies to one and not the other. Per-board cutoffs are a schema change — defer,
   but *surface* the mismatch as a warning.

### Correction to the research report, load-bearing for the design

**Specificity ties are order-dependent.** In `worker/src/risk/logic/scoring.ts` L64-75,
`specificity()` scores `column`-only and `size`-only rules *both as 1*, and `Array.prototype.sort`
is stable — so a `{column:'Code Review'}` rule and a `{size:5}` rule that both match one ticket
are resolved by **array position**. The shipped defaults never hit this (idle/timeInColumn use
column-only rules; cycle uses size-only rules), but the moment an admin adds one column rule to
`cycle`, order silently starts mattering. Any editor that claims "order doesn't matter" must
handle this case.

---

## 1. New shared module — `shared/src/risk-cutoffs.ts`

Pure, framework-free, no worker/client imports. Exports:

**Moved from `scoring.ts`** (re-exported there for back-compat):
`FIB_BUCKETS`, `sizeBucket()`, `resolveCutoff()`, `Cutoff`, `CutoffMetricId`, `HARD_FALLBACK`.

**Vocabulary the UI needs:**
- `CUTOFF_METRICS: {id, label, help}[]` — `idle` → "Last movement", `timeInColumn` → "In column",
  `cycle` → "Cycle" (reuse `METRIC_LABELS` wording from `client/src/app/risk/format.ts` L23-29 so
  the admin page and the board agree).
- `SIZE_BUCKET_LABELS` — the single best teaching device against the size-bucket trap. Render
  buckets as the *point ranges they actually capture*, derived from `sizeBucket`:
  `none`→"Unpointed", `1`→"1", `2`→"2", `3`→"3", `5`→"4–5", `8`→"6–8", `13`→"9–13",
  `20`→"14–20 (and 21+)". Generate from `FIB_BUCKETS` so they can't drift.
- `WORK_HOURS_PER_DAY = 8` — currently duplicated as `HOURS_PER_WORKDAY` in
  `client/src/app/risk/format.ts` L9; move it here and have `format.ts` import it.
- `workHoursPerWeek(schedule)` / `workHoursPerDay(schedule)` — derived from the *effective*
  `RiskWorkSchedule`, used to write the units caption from real data instead of a hardcoded
  sentence.

**Validation:**
```
validateCutoffs(cutoffs, ctx?: { columns, doneColumns, pointsFieldConfigured })
  → { errors: RiskConfigIssue[], warnings: RiskConfigIssue[] }
```
`RiskConfigIssue = { metric?: CutoffMetricId; index?: number; field?: 'column'|'size'|'warn'|'risk'|'default'; code: string; message: string }`
— added to `shared/src/risk.ts` alongside the other wire types, plus an optional
`issues?: RiskConfigIssue[]` on the error body (extend `ApiError` in `shared/src/contracts.ts`
with an optional field — additive, back-compatible).

`ctx` is optional so the worker can run the context-free subset and the client the full set with
board columns loaded.

**Normalization / editor-model transforms** (pure, unit-testable — which is why they live here;
`client/CLAUDE.md`: "There is no standalone client test suite"):
- `toEditorModel(cutoffs)` → `{ metric; rows: EditorRow[]; fallback: {warn,risk}|null; unrepresentable: RiskConfigIssue[] }[]`
  where `EditorRow = { key: string; column: string|null; size: number|'none'|null; warn: number; risk: number }`.
- `fromEditorModel(model)` → `RiskCutoffs` (emits `{default:true, ...}` for the fallback row).
- `collapseRedundantRules(rules)` — **behavior-preserving**: drop a `{column:C, size:S}` rule when
  a `{column:C}` rule exists with identical `warn`/`risk`, and drop a `{size:S}` rule when a
  size-less same-scope rule matches identically. Turns `DEFAULT_CUTOFFS.idle`'s 64 rows into 8
  with provably identical `resolveCutoff` output for every (column, bucket) pair. Never
  auto-saved — applied on load, shown as "simplified N redundant rows", written only on save.
- `ambiguousPairs(rules)` — the tie finder from the correction above: pairs of equal-specificity
  rules that can both match one ticket (a column-only rule and a size-only rule in the same
  metric), reported with the concrete winner.

Barrel line in `shared/src/index.ts`; delete both with the feature.

---

## 2. Server changes

### `worker/src/risk/routes.ts`
- Replace `validRule` / `validCutoffs` (L281-301) with `validateCutoffs()` from shared. Return
  `error(400, 'invalid cutoffs', 'INVALID_CUTOFFS')` *plus* an `issues` array — extend `error()`
  in `worker/src/http.ts` L12-15 with an optional `extra` object.
- New route in `riskAdminRoutes` (L128-139): `GET /api/admin/risk/columns` →
  ```
  { boards: [{ boardId, name, columns: string[], doneColumn: string|null, source: 'snapshot'|'live'|'unavailable' }],
    pointsFieldConfigured: boolean,
    probeError: string | null }
  ```
  Resolution order per board: **stored snapshot first** (`snapshot.columns`, zero Jira calls —
  matches the read-path invariant), falling back to `fetchBoardMaps` with the *admin's* token for
  boards configured but never refreshed. `doneColumn` = last element (mirroring `isDoneColumn` in
  `logic/health.ts` L47-49 — import it rather than re-deriving). `pointsFieldConfigured` from
  `ctx.dao.getConfig(cloudId).storyPointsFieldId != null`, which lets the UI explain the
  size-bucket dead zone (closes part of `DEFERRED.md` L51-63 — note that there).
- Keep `PUT /api/admin/risk/config` contract identical otherwise; `putRiskConfig` still accepts
  `cutoffs: null` for "inherit".

### `worker/src/risk/store.ts`
- Add `listSnapshotColumns(env, cloudId): Promise<{boardId, columns, computedAt}[]>` — one
  `SELECT board_id, snapshot_json` over `risk_snapshots` for the org. Keeps the "only store.ts
  touches `risk_*` tables" convention intact.

### `worker/src/risk/logic/scoring.ts`
- Becomes a thin re-export for the moved primitives. No logic change → `worker/test/risk-scoring.test.ts`
  must pass untouched, which is the regression gate for the move.

---

## 3. Validation matrix (the currently-unvalidated cases)

| Case | Today | Proposed | Why |
|---|---|---|---|
| `cutoffs` not an object | crashes into `.every` / passes weirdly | **error** | trivially broken |
| missing one of the three metric keys | error already | error (with which key) | |
| rule with only `warn` or only `risk` | shape-valid, silently skipped (`scoring.ts` L76) | **error** (`INCOMPLETE_RULE`), auto-repaired by the loader | a rule that can never fire is always a mistake |
| `size` not in `FIB_BUCKETS ∪ {'none'}` (e.g. `4`) | accepted, can never match | **error** (`NOT_A_BUCKET`), loader snaps to `sizeBucket(4)=5` with a visible diff | |
| unknown extra keys on a rule | accepted, ignored | **warning** (client) + stripped by the editor | tolerant read, honest write |
| multiple `default:true` in one metric | first wins silently | **error** (`DUPLICATE_DEFAULT`) | ambiguous |
| duplicate `(column,size)` within a metric | stable-sort first wins | **error** (`DUPLICATE_SCOPE`) | editor rows are keyed, so unreachable from the UI; only imports hit it |
| equal-specificity ambiguity (column-only vs size-only) | order decides, invisibly | **warning**, naming the winner | the §0 correction; can't be an error without breaking legal configs |
| no `default:true` rule | falls to `HARD_FALLBACK` (`cycle` jumps 19/32 → 160/240) | **warning**, and the UI *always* renders a fallback row showing the effective numbers | |
| `column` matches no configured board column | silently degrades to default | **warning**, per board ("matches *Sprint A* but not *Sprint B*") | |
| rule targets a board's last/Done column | dead — done tickets are never scored (`health.ts` L100-113) | **warning** + "remove dead Done rules" action on import | |
| size-specific rules with no Story Points field | never fire | **warning** on the whole size dimension, linking to the field picker | `DEFERRED.md` L51 |
| `risk = 0`, non-finite, `risk < warn` | error already | unchanged, but now per-row with an index | |

**Back-compat caveat, state explicitly in the UI:** three of these move from "accepted" to
"error", so an org with a legacy blob containing a half-rule or a `size: 4` cannot re-save it
unchanged. Mitigation is the loader's auto-repair with a visible "we changed N rules on load"
callout before the first save. Reads are unaffected — `store.ts` `parseJson` (L94-101) stays
tolerant, so no existing board breaks at refresh time.

---

## 4. Client UI

### File structure
- `client/src/app/risk/risk-admin.component.ts` — shrinks: keeps boards / refresher / fields,
  drops the three JSON textareas, hosts the new children, owns save + the message banner.
- `client/src/app/risk/cutoffs-editor.component.ts` (new) — `<sp-risk-cutoffs>`; `input()` for the
  org's `cutoffs`, the `defaults`, the effective `schedule`, and the columns response; `output()`
  emitting `RiskCutoffs | null` (null = inherit). Owns the tab group and the three tables.
- `client/src/app/risk/composite-editor.component.ts` (new, phase 5) — `<sp-risk-composite>`.
- `client/src/app/api.service.ts` — add `adminRiskColumns()`.
- `client/src/webawesome.ts` — register newly used elements: `tab`, `tab-group`, `tab-panel`,
  `number-input`, `tooltip`, `badge`, `radio`/`radio-group` (units toggle), `popover`.
  (`wa-number-input` exists in the installed `@awesome.me/webawesome` and is marked *experimental
  since 3.2* — if that's a concern, fall back to `<wa-input type="number">`, already registered.
  There is **no free data-grid**, so the table is hand-rolled markup styled with the existing
  `.panel`/`.row` conventions.)

### Panel anatomy (per metric tab)

```
[ Thresholds ]
  ┌ wa-switch: "Use the built-in defaults"  ── ON  ────────────────────────┐
  │  (off → the table below becomes yours; a callout explains the freeze)  │
  └───────────────────────────────────────────────────────────────────────┘
  <wa-tab-group>  Last movement | In column | Cycle
    ── units caption, computed from the live schedule ──
       "Hours are WORK hours: your week is 40h (Mon–Thu 9–18, Fri 9–13,
        America/New_York) ≈ 8h per working day. 24h = 3 working days."
    ── table ──
       Scope (column)        Size            Warn ≥        Risk ≥
       [Any column ▾]        [Any size ▾]    [ 4 ] h/d     [ 9 ] h/d   [x]
       ...
       Everything else       —               [ 24 ] h/d    [ 72 ] h/d   (pinned, undeletable)
    [+ Add rule]   [ Test a ticket ▸ ]   [ ▸ Advanced: JSON ]
```

**Design decisions that map 1:1 to the traps:**

- **Work-hours units.** Every numeric cell is a `<wa-number-input>` plus a per-table unit toggle
  (`work hours` / `work days`), storing hours always. Below each value, a live caption via
  `fmtWorkHM` ("3d 0h"). The header caption is *derived from the effective schedule*
  (`workHoursPerWeek`), so changing the schedule visibly changes what "24 hours" means. If the org
  has no custom schedule, say "built-in schedule".
- **Size buckets.** The Size select shows ranges (`4–5`, `14–20 (and 21+)`, `Unpointed`) — the
  admin can't think "4 points" and type `4`. When `pointsFieldConfigured === false`, the whole Size
  column is disabled with a `<wa-callout variant="warning">`: "No Story Points field is resolved
  for this site, so every ticket counts as *Unpointed* — size rules will never fire." Link to the
  field picker on the same page.
- **Specificity, not order.** Rows are *sorted for display by specificity* (most specific first)
  with a `<wa-badge>`/tooltip per row ("beats rules that only set a column"), and there are no
  reorder handles — the absence of drag handles is itself the lesson. Equal-specificity ambiguity
  gets an inline `<wa-callout variant="warning">` naming the winner. The **"Test a ticket"**
  disclosure is the payoff: pick a column + a size, and it renders the winning rule (highlighting
  that row) and the resulting `warn ≥ … · risk ≥ …` in the exact wording of `thresholdLabel` in
  `format.ts` L96-102 — computed with the *shared* `resolveCutoff`, so it can never lie.
- **warn vs risk asymmetry.** Column headers: `Warn ≥ (badge only)` and `Risk ≥ (drives the score)`,
  with a `<wa-tooltip>` on Risk: "A ticket's score is *value ÷ risk*, so lowering this raises the
  composite for every matching ticket and can flip the board." Optionally a 3-zone mini-bar per row
  (ok / warn / risk) — cheap, and it makes inclusivity (`≥`) visible.
- **Dead `Done` rules.** The Scope select groups options: *Any column*, then real columns per board,
  with the last column of each board rendered as "Done — never scored" and disabled by default
  (selectable only from a "show done columns" escape). Legacy blobs containing Done rules get a
  "remove N dead rules" one-click action.
- **Blank = inherit vs pasted copy = frozen.** The `wa-switch` makes this a first-class, labeled
  choice instead of an emergent property of an empty textarea:
  - ON (stored `NULL`): the table renders the *defaults, read-only*, with "You're following the
    shipped defaults; they'll keep improving."
  - Flipping OFF: copies the defaults into an editable model and shows
    `<wa-callout variant="warning">`: "You now own these thresholds. Future improvements to the
    shipped defaults will no longer reach this site."
  - Flipping back ON: `<wa-dialog>` confirm — "Discard your customizations and follow the shipped
    defaults again?"
- **Escape hatch.** `<wa-details summary="Advanced: edit as JSON">` containing a read-only
  `<pre class="ref">` of the *current model* + `<wa-copy-button>`, and an "Import JSON…" button
  opening a `<wa-dialog>` with a `<wa-textarea>`. Import runs `validateCutoffs` + `toEditorModel`;
  errors are listed with metric/index/field and the import is refused; warnings and auto-repairs
  are listed and the admin confirms.

### Server-side vs client-side split
- **Server:** authoritative validation (same shared function), board columns + done-column
  identity, points-field availability, persistence, and the `NULL`-means-inherit semantics. Never
  trust the client's warnings.
- **Client:** editor model, unit conversion, ordering/display, warnings, resolution preview, JSON
  import/export. No ticket scoring.

---

## 5. Sequencing

1. **Shared module + move.** Create `shared/src/risk-cutoffs.ts`, move the resolution primitives,
   re-export from `scoring.ts`, add types to `risk.ts`, barrel line. Gate:
   `worker/test/risk-scoring.test.ts` and `risk-refresh.test.ts` pass unchanged.
2. **Validator + normalizers + tests** in shared. No UI yet.
3. **Server:** `routes.ts` switches to the shared validator with structured `issues`; add
   `GET /api/admin/risk/columns` + `store.listSnapshotColumns`; `api.service.ts` method.
4. **Client:** `cutoffs-editor.component.ts` + wire into `risk-admin.component.ts`; register the
   new `wa-*` elements. Ship with the JSON import/export path so nothing is lost.
5. **Composite editor** (small): `p` as a labeled slider ("weighted average ↔ worst metric
   dominates") and five weight inputs where `0` renders as an explicit **Excluded** state
   (`scoring.ts` L106 — weight ≤ 0 drops the metric entirely; a blank weight defaults to 1, which
   is *not* the same as 0). Keep the schedule as JSON for now but render its derived summary
   ("40 work hours/week") wherever hours are entered.
6. **Docs:** update `client/CLAUDE.md` (new files + the narrowed no-client-math rule),
   `shared/CLAUDE.md` (risk.ts is no longer types-only; new module + its tests),
   `worker/CLAUDE.md` (new admin route), `DEFERRED.md` (what's now covered, what's newly deferred).

---

## 6. Tests

- **`shared/test/risk-cutoffs.test.ts` (new)** — one case per row of the §3 matrix;
  `toEditorModel`/`fromEditorModel` round-trip on `DEFAULT_CUTOFFS`; `collapseRedundantRules`
  idempotence; `ambiguousPairs` on a column-rule + size-rule pair; `sizeBucket` labels cover every
  bucket including the 21+ clamp; `workHoursPerWeek(DEFAULT_SCHEDULE) === 40`.
- **`worker/test/risk-cutoff-editor.test.ts` (new)** — the load-bearing equivalence test: for every
  (column ∈ board columns ∪ {"Nope"}) × (points ∈ 0..25, null), `resolveCutoff` on
  `DEFAULT_CUTOFFS` equals `resolveCutoff` on `collapseRedundantRules(DEFAULT_CUTOFFS)` and on
  `fromEditorModel(toEditorModel(DEFAULT_CUTOFFS))`. This is what makes the 64→8 row collapse safe.
- **`worker/test/risk-routes.test.ts` (extend)** — each new 400 with its `issues` payload
  (metric + index + code); `cutoffs: null` still stores NULL and still echoes `defaults`;
  `GET /api/admin/risk/columns` prefers the stored snapshot (assert zero Jira calls, using the
  existing `SqliteD1` harness), falls back to live, and is inside the `requireAdmin` block.
- **`worker/test/risk-scoring.test.ts` (extend)** — explicit regressions for the two facts the UI
  now advertises: no `default` rule → `HARD_FALLBACK` (esp. `cycle` 160/240), and equal-specificity
  ties resolve by array order.
- **`worker/test/risk-store.test.ts` (extend)** — `listSnapshotColumns` org scoping, and a corrupt
  `snapshot_json` row degrading to "unavailable" rather than throwing.

---

## 7. Recommended deferrals

- **Impact preview** ("with these thresholds: 12 risk / 9 warn / 40 ok, was 6 / 8 / 47").
  Technically cheap — `POST /api/admin/risk/preview` re-running `evaluateTicket` over the stored
  snapshot tickets (all raw inputs are already in `RiskBoardSnapshot`) — and by far the strongest
  anti-footgun. Deferred only because it's an extra endpoint + shared shape; **do it next**, not
  never.
- **Per-board cutoffs.** Needs a schema change; the multi-board column mismatch warning covers the
  pain in the meantime.
- **Full work-schedule editor** (7 day rows + a timezone picker). Reading the schedule and deriving
  the units caption is phase 1; editing it visually is separate.
- **Making the dead `Done` rules impossible** (a server-side rejection). Warning-only for now —
  "last column" is per-board and would reject configs that are correct for one board.
- **Structured `issues` for composite/schedule.** Reuse the same `RiskConfigIssue` shape when those
  editors land.

### Critical files
- `shared/src/risk.ts`
- `worker/src/risk/logic/scoring.ts`
- `worker/src/risk/routes.ts`
- `client/src/app/risk/risk-admin.component.ts`
- `worker/src/risk/logic/defaults.ts`
