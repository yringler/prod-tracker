# Plan: repair the risk-admin cutoffs editor

## 0. Key finding that sets the ordering

All six `String(...)` sites sit INSIDE an `@for`/`@if` (an embedded view):
- `cutoffs-editor.component.ts:174,179` (inside `@for (row of rows())`)
- `cutoffs-editor.component.ts:296` (inside `@for (s of sizes)` / `@if`)
- `composite-editor.component.ts:87` (inside `@for (m of metricIds)`)
- `risk-board.component.ts:32,34` (inside `@if (boards().length > 1)`) -- PRE-EXISTING

That is the mechanism, not a coincidence. With `strictTemplates` and `fullTemplateTypeCheck`
both unset, Angular runs *basic* template checking, which checks top-level binding expressions
but NOT embedded views (`node_modules/@angular/compiler-cli/src/ngtsc/core/api/src/public_options.d.ts:23-37`;
`fullTemplateTypeCheck` is deprecated-but-supported in the installed `@angular/core@21.2.17`).

So the minimum flag that turns all six into build errors is **`fullTemplateTypeCheck: true`**,
NOT `strictTemplates`. It does not imply `strictInputTypes`/`strictNullInputTypes`/
`strictAttributeTypes`/`strictDomEventTypes` (each defaults false even when it is set), so its
blast radius is ~only "expressions inside `@if`/`@for`/`ng-template` are now checked against the
component class" -- exactly the hole, at a fraction of the triage cost. `strictTemplates` becomes
a separate, measured, optional step.

## 1. Ordering and gates

### Step 1 -- Baseline, no changes
Build and load `/risk/admin` against a stored cutoffs blob with no `default:true` rule. Record the
five symptom regions (rows 2..N blank, blank `wa-option` labels, empty yellow callouts, "Add rule"
no-op, Done-scope row blank). This is the manual acceptance list for every later step.
**Gate:** console shows a TypeError inside `refreshView`/`detectChangesInEmbeddedViews`.

### Step 2 -- Turn the bug class into a compile error
Add `angularCompilerOptions: { fullTemplateTypeCheck: true }` to `client/tsconfig.app.json` (the
tsconfig the build uses per `client/angular.json` -> `build.options.tsConfig`; `client/tsconfig.json`
extends it so editors pick it up). Client project only; root/worker/shared untouched, `npm run
typecheck` unaffected.
**Gate (the important one):** `npm run build:client` must now FAIL, at exactly the six known sites
plus anything else hidden in embedded views. If it fails at ZERO sites the flag is not reaching the
compiler and everything downstream is unverified. Capture the full error list first -- that list IS
the blast-radius measurement.

### Step 3 -- Fix the six (and any siblings surfaced)
Replace template `String(x)` with component-side members. Do NOT add a `String = String` field to
the class -- it fixes the build while re-hiding the bug class.
- size selects: option list becomes a precomputed view model (see S5), so the calls disappear.
- `composite-editor:87`: a `weightText(m): string` method (prefer explicit string method, matching `disp()`).
- `risk-board:32,34`: `boardValue(b)`/`selectedValue()`. Pre-existing + latent; fix in the same
  commit but call out separately -- different screen.
**Gate:** `build:client` green; all rows, option labels, non-empty callouts render. Re-check step 1
list. STOP AND CONFIRM before touching behavior, so later steps debug against a working baseline.

### Step 4 -- Measure `strictTemplates` separately, then decide
Throwaway build with `strictTemplates: true`; count/classify errors. Expected: `CUSTOM_ELEMENTS_SCHEMA`
suppresses property/attr checks on `wa-*`, so most of the ~200 `<wa-*>` bindings do NOT error;
likely hits are `strictNullInputTypes` on Angular-component inputs and `strictDomEventTypes` on
`(change)="...($event)"` on known DOM elements.
**Decision rule, fixed in advance:** if <= ~15 errors and every fix is a genuine type improvement,
fix them and keep `strictTemplates: true`. If more, or any fix needs a cast/`$any`, keep
`fullTemplateTypeCheck` only and record the migration + measured count in `DEFERRED.md`. The bug is
caught either way; `strictTemplates` is defense in depth, not the fix.

### Steps 5-9
S5 feedback loop (§3) -> S6 WA select contract (§5) -> S7 decomposition (§4) -> S8 `timeInColumn`
presentation (§2) -> S9 copy (§7) + columns fetch (§8).
Rationale: §3 before §8 (grouping UI is unevaluable while every keystroke re-collapses the model);
§4 before §8 (the group component needs the row component); §5 lands with §4 (it IS one of the files).

## 2. The `timeInColumn` 33-row presentation problem

### What the data is
`worker/src/risk/logic/defaults.ts:100-176` -- `timeInColumn` has two populations:
- FLAT columns: `Blocked` 24/72, `To Do` 16/48, `Done` 100/250 -- identical across all 8 buckets,
  so each collapses to one column-only row.
- LADDERED columns: `In Progress`, `Code Review 1`, `Code Review 2`, `Pending QA` -- a genuine
  monotonic size ladder (`In Progress` 1pt=1/2 ... 20pt=36/48); only the `none` row is redundant.
  Each collapses to a column-only row + 7 size rows.
So 33 rows is really **7 columns**, 3 one-liners + 4 ladders. That structure is stable: any org that
hand-tunes this produces the same shape, because that is what the resolver's specificity rewards.

### Option A -- group by column, summary + disclosure
One group per column in board-column order (from `columnGroups()`), then unknown columns, then the
"Any column" group, then the fallback row. Header carries the column-only rule's Warn/Risk inline
plus a badge ("7 size rules - 1h -> 48h"); chevron expands to size rows (today's row component).
- Teaching buckets: MEDIUM -- ranges visible only once expanded, but the badge advertises the ladder
  and header/child nesting says "size refines column", which is the actual rule.
- Which rule wins: STRONG, better than today -- the nesting IS the specificity order (size row inside
  a column group beats its header, beats "Any column", beats fallback). Today's flat list asserts
  that typographically; this makes it structural.
- Edit ergonomics: good for the common edit ("Code Review 2 too tight"); poor for cross-column bulk.
- First open: `timeInColumn` = 7 collapsed lines + fallback; `idle`/`cycle` (7 rows each) render as
  one-liner groups, visually indistinguishable from today. That "degrades to the current UI"
  property is worth a lot.

### Option B -- column x size matrix
Rows = columns (+ Any), cols = 8 buckets (+ Any), cell = Warn/Risk pair, blank = inherits (shaded).
- Teaching buckets: STRONGEST -- ranges are permanent headers, always on screen, adjacent.
- Which rule wins: STRONGEST for READING -- inheritance is spatial, whole surface at once.
- Ergonomics: 8x9=72 cells x 2 inputs = 144 inputs in DOM, horizontal scroll on any real admin
  viewport, and no natural place for per-row delete, the "Any column" asymmetry, or per-rule
  validation callouts (currently a flat list keyed by rule index).
- First open: dense 72-cell grid ~80% empty for idle/cycle, ~45% for timeInColumn. Presents the
  SPACE of rules rather than the SET the org has -- overstates how much config exists.

### RECOMMENDATION: A for editing, recover B's value read-only
Take **Option A**. Then recover B's single best property ("see the whole resolution surface") as a
**read-only resolved matrix** inside the existing `<wa-details summary="Test a ticket">`: every
(column,bucket) cell showing resolved warn/risk via the shared `resolveCutoff`, tinted by which rule
produced it. Cheap (pure derived data, no inputs, no validation anchoring, no delete buttons), honest
(shows resolution, not rules), and upgrades "Test a ticket" from a point-probe to the whole surface.
Defer to a follow-up if S8 runs long; the accordion is the shippable half.
Reject B as primary: wins on teaching, loses on validation callouts, per-rule deletion, the
Any-column/fallback asymmetry, and narrow viewports -- and it is a full rewrite of the editing
surface rather than a wrapper around the row component that already exists.

### Behavior details for A (specify explicitly)
- Grouping key `row.column ?? null`. Order: board column order from `columnGroups()`, then columns on
  no board (surface the existing UNKNOWN_COLUMN warning on the group header), then the `null`
  "Any column" group, then the pinned fallback row.
- Default expansion: expand iff the group has <=1 size row OR the metric's total row count is < ~10.
  So `idle`/`cycle` are fully expanded exactly as today; `timeInColumn` opens collapsed. No new
  interaction to learn on the two tables that were already fine.
- FORCE-EXPAND any group containing a row with an error/warning in `validation()`. Otherwise callouts
  point at rules the admin cannot see -- the same "message with no referent" failure as root cause D.
- A group with no column-only rule: header shows what that column actually falls through to (run
  `resolveCutoff` for `(column,'none')`) plus an "Add a rule for this column" affordance. Do NOT
  render an empty input pair there -- that is D's bug in a new place.
- "Add rule" moves into the group header (`addRow(column)`), pre-filled with that column and the
  first free bucket. The global button stays for the "Any column" group.

### Latent ordering bug to fix while here
`sortRowsForDisplay` (`shared/src/risk-cutoffs.ts:681-689`) scores column-only 2 and size-only 1, so
it renders column-only above size-only. But `resolveRules` (`:97-99`) scores BOTH 1 -- they are
equally specific and the winner is decided by ARRAY POSITION in the stored blob (exactly what
`ambiguousPairs`/`AMBIGUOUS_SPECIFICITY` warns about). Meanwhile `fromEditorModel` serializes
`m.rows` in MODEL order, not display order. So the UI asserts a precedence the resolver does not
honor, and the position that actually decides is invisible. Grouping makes this worse (column rules
and Any-column rules land in different groups, further implying precedence).
FIX: serialize in display order -- pass `sortRowsForDisplay(...)`-ordered rows into `fromEditorModel`
so WHAT YOU SEE IS THE TIE-BREAK ORDER -- and add a shared test asserting the round trip preserves
resolution on a table with a deliberate tie. USER-VISIBLE (can change which of two tied rules wins).

## 3. Feedback loop (root cause E)

### Fix: make the editor uncontrolled after mount, IN THE PARENT
Do not patch inside the editor with a reference-equality guard against "the last thing I emitted" --
it works, but leaves a two-way binding the next contributor will re-break. Fix the data flow in
`risk-admin.component.ts`:
- Split the parent's single `cutoffs` signal in two:
  - `serverCutoffs = signal<RiskCutoffs|null>(null)` -- written ONLY by the `ngOnInit` response and
    by a successful save. This is what `[cutoffs]` binds to.
  - `cutoffs = signal<RiskCutoffs|null>(null)` -- the draft. Written ONLY by `(cutoffsChange)`. Read
    by `save()` and by `<sp-risk-impact [cutoffs]>`.
- `ngOnInit` sets both from `r.config.cutoffs`. A successful save sets `serverCutoffs` from the body
  it just sent (it already bumps `savedAt` for the same reason).
Now the editor's constructor effect fires on real reloads only. Nothing else changes in ownership.
Apply the identical split to `composite` for symmetry (benign today since `normalize()` is
idempotent -- but the asymmetry is the trap).

### Consequences to comment explicitly
- `collapseCutoffs` now runs ONLY in `load()`, reachable from exactly three places: the input effect,
  the follow-defaults transitions (`onFollowDefaults`/`applyFollowDefaults`), and `doImport`. Add an
  assertion-by-comment at `load()`: *collapse runs on load, never on edit; running it on a model
  containing a just-added row will delete the row.*
- `repairs()`/`simplified()` become load-time facts and stop re-announcing per keystroke -- which is
  what makes the S7 copy fix coherent.
- The fixpoint collapse (O(n^2) equivalence probes to a fixpoint over a 33-rule table with an
  8-col x 9-bucket probe space) stops running per keystroke. Real responsiveness win.

### Where `addRow` gets its seed -- two independent problems
1. It gets collapsed away -> solved structurally above (collapse is load-only).
2. It is seeded to a provably redundant value. `addRow()` seeds from `fallback()`. Change the seed to
   `resolveCutoff(current(), metric, column, size)` for the NEW ROW'S OWN SCOPE -- the rule starts at
   whatever that scope resolves to today. Correct invariant: **adding a rule changes no resolution
   until you type in it.** (Seeding from `fallback()` violates this whenever a column rule already
   covers the scope.) Still "redundant" in the collapse sense, which is fine now that collapse is
   load-only -- say so in the comment so nobody re-adds collapse-on-emit.
3. Slot picking: today it scans `[null,...columns] x [null,...buckets]` and picks the first free slot,
   almost always `(any column, any size)` -- a rule most admins did not want. With grouping,
   `addRow(column)` takes the column from the header and picks the first free bucket within it,
   falling back to the column-only slot. Mark the row (`isNew`) and focus its Warn input, so "Add
   rule" has visible feedback even when seeded numbers match what was already resolving.

## 4. Decomposition -- confirmed, with revisions

Confirm: narrow extraction, NO shared service or store. Candidate state is 3 signals + 1 computed
threaded one-way in ~15 lines; `impact-preview` is a pure consumer; a store adds a file and obscures
ownership against `worker/CLAUDE.md`'s "IT MUST BE EASY TO DELETE" contract. Also keep the honest
framing in the PR: **the 677-line file did not cause any of these defects** -- it cost
diagnosability, and that is the only thing decomposition buys.
Revision: take ONE `option-select` (not scope-select + size-select), and add a GROUP component that
Option A requires.

### New files
**`client/src/app/risk/option-select.component.ts`** -- `<sp-option-select>`, single owner of the WA
select contract (S5).
- Inputs: `value: string|null` (required), `options: SelectOption[]` (required), `placeholder?`,
  `disabled = false`, `size = 'small'`, `ariaLabel?`.
- Output: `valueChange: string` (normalized: never null, never array; `''` is the explicit "any"
  sentinel, documented on the type).
- Exported: `interface SelectOption { value: string; label: string; group?: string; disabled?: boolean; note?: string }`.
- ~80 lines. Used by cutoff row (x2), "Test a ticket" (x2), refresher + field pickers in risk-admin
  (x5), board picker in risk-board (x1) -- where the six-call-site duplication actually collapses.

**`client/src/app/risk/cutoff-row.component.ts`** -- one editable rule.
- **Selector MUST be `tr[sp-cutoff-row]`** (attribute selector, so the host element IS the `<tr>`).
  An element selector inside `<tbody>` breaks table layout and browsers hoist it out of the table.
  This is the easiest thing in the plan to get silently wrong.
- Inputs: `row: EditorRow` (required), `columnOptions`, `sizeOptions`, `unit`, `hoursPerDay`,
  `readonly`, `sizeDisabled`, `issues: RiskConfigIssue[]`.
- Outputs: `scopeChange: {column: string|null; size: SizeBucketKey|null}`,
  `thresholdChange: {field:'warn'|'risk'; hours:number}`, `remove: void`.
- Owns hours<->days display conversion (`disp`/`toHours` move here, plus the `hm()` caption). ~110 lines.

**`client/src/app/risk/cutoff-group.component.ts`** -- the per-column disclosure group of S2.
- Inputs: `column: string|null`, `headerRow: EditorRow|null`, `sizeRows: EditorRow[]`,
  `resolvedFallthrough: Cutoff`, `expanded: boolean`, plus row pass-throughs.
- Outputs: `toggle`, `addRule`, and the row outputs re-emitted with row identity attached. ~90 lines.

**`client/src/app/risk/dom-events.ts`** -- `targetValue(e)`, `targetChecked(e)`, `selectValue(e)`
(the WA-select-aware read handling `null` and array values). Pure functions, no class, no DI.
Replaces copy-pasted `value(e)`/`checked(e)` in cutoffs-editor, composite-editor, risk-admin,
risk-board. A base directive is the wrong tool -- no template, no lifecycle, no state.

### Stays in `cutoffs-editor.component.ts`
Model ownership (`model`/`custom`/`load`/`patch`/`emit`), tabs, units caption + hours/days toggle,
fallback row, callout stack, "Test a ticket", JSON import/export dialogs, the grouping computed.
~380 lines after the move -- still the biggest file in the slice, appropriately so: it owns the model.

### Moves to `shared/`
The grouping/mutation logic is pure `EditorMetricModel` math, which `shared/src/risk-cutoffs.ts`
already owns by charter ("config-editing math is shared"). Move/add there so it is testable with
zero new infra (S6): `groupRowsByColumn(rows, columnOrder)`, `applyScopeChange(model, rowKey, column,
size)`, `seedRowFor(cutoffs, metric, column, size)`, `parseSizeValue(raw): SizeBucketKey|null|undefined`
(undefined = reject, do not write). Keep UI vocabulary (`SelectOption` builders) client-side.

## 5. The Web Awesome select contract -- one place

`<sp-option-select>` enforces these; nothing else touches a `wa-select`'s value or options.
1. **Never bind a value not in the option list.** If `value` is not found, synthesize an option for
   it, appended and annotated (`note: 'not on any configured board'`). Confirmed from
   `node_modules/@awesome.me/webawesome/dist/chunks/chunk.XDP6OHLP.js:271-284`: the getter filters the
   bound value against the option set and returns null otherwise, blanking display AND read-back.
   The Done case is one instance; a stored column that no longer exists on any board is another the
   current code also has.
2. **Never mark the currently-selected option `disabled`.** Same path: `.filter(o => !o.disabled)`,
   so a disabled option can never be the value. `cutoffs-editor.component.ts:163` violates this. The
   component enforces it by clearing `disabled` on the option whose value equals `value`.
3. **`disabled` is not the encoding for "not offered".** Where the intent is "not available here",
   OMIT the option. Reserve `disabled` for visible-but-unselectable, which -- given rules 1-2 -- this
   app does not currently have. Consider forbidding `disabled` on options and dropping it from the type.
4. **Normalize the read-back once.** `selectValue(e)` handles null and array values, returns `''` for
   nothing. `value(e)` at `:537` (typed `string`, actually `string|null|string[]`) is the bug source;
   `setScope` at `:605` turning that into `Number(null) === 0` -- not a `SizeBucketKey` -- is the damage.
5. **Reject, don't coerce.** `parseSizeValue` returns `undefined` for anything not in
   `SIZE_BUCKET_KEYS`, and `setScope` RETURNS EARLY on undefined rather than writing a value the
   validator will later reject. Same for `''`->null (any size), `'none'`->'none'. Guard `valueChange`
   to emit only on actual change (WA fires `change` liberally; every spurious emit is a parent round trip).

### What `showDone` should do
Redefine as **"offer Done columns as choices"**, not "grey them out":
- A row whose OWN scope is a Done column always shows that column, selected and labelled, regardless
  of the toggle. Falls out of rule 1 for free. Direct fix for the shipped `idle`/`timeInColumn`
  tables, both of which ship a Done rule (`defaults.ts:163-171`).
- The toggle controls only whether OTHER rows' pickers list Done columns as new choices, by
  inclusion/exclusion of the option, never `disabled`.
- Default `showDone` to TRUE when the loaded model contains any Done-column rule. Otherwise the
  toggle is off while a Done rule is plainly visible -- the same self-contradiction as D.
- Keep the `DONE_COLUMN_RULE` warning (`risk-cutoffs.ts:391-400`) as the explanation; with S2's
  force-expand it attaches to a visible row. ALSO attach it inline on the row (small badge on the
  scope cell) rather than only in the bottom callout stack, which is index-addressed and, once
  grouped, far from the rule it describes.
- The row-level `[attr.disabled]` on the `wa-select` itself (read-only while following defaults) is a
  DIFFERENT mechanism and is fine; keep it, pass it as the component's `disabled` input.

## 6. Testing -- argued position

**What the flag buys.** `fullTemplateTypeCheck` converts this entire bug CLASS (any template
expression referencing a JS global or non-existent member, anywhere inside an embedded view) into a
build failure -- and `wrangler.toml`'s `[build]` already runs `npm run test && npm run build:client`
before dev and deploy, so the gate was already wired; the FLAG was missing, not the gate. For the
defect that shipped this is a complete fix and the highest-value single line in the plan.
**What it does not buy.** It cannot catch `Number(null) === 0`, the output->input feedback loop,
`wa-select` filtering its value against non-disabled options, or "collapse deletes the row you just
added." Those are runtime/semantic. So some test lift is warranted -- the question is how much.

**Tier 1 (do): the flag + the existing build gate.** No new infra.

**Tier 2 (do -- near-zero infra): test the pure logic where it already can be tested.** Everything
semantically risky here is a pure function over `EditorMetricModel`/`RiskCutoffs`. Per S4 those move
to `shared/src/risk-cutoffs.ts`, already covered by `shared/test/risk-cutoffs.test.ts` under the
existing vitest run -- ZERO config change. Cover:
- `parseSizeValue` rejects `null`/`''`/`'0'`/`'4'`/arrays instead of coercing (the `Number(null)` bug).
- `seedRowFor` -- adding a rule at ANY scope changes NO resolution (assert `resolveCutoff` identical
  before/after over the whole probe space). The invariant that makes "Add rule" correct.
- `groupRowsByColumn` -- every row lands in exactly one group; group order matches supplied column
  order; unknown columns and the null group land last.
- Round trip in DISPLAY order (S2's ordering fix), including a deliberate column-only/size-only tie.
Then extend `worker/test/risk-cutoff-editor.test.ts` (which already owns assertions against the real
shipped tables): `timeInColumn` collapses 64 -> 33 and grouping yields 7 column groups of which 3 are
single-row -- pinning the numbers the whole S2 design rests on, so a defaults edit that breaks the
presentation assumption fails a test.
For the option-list builder (`SelectOption[]` from board columns + `showDone` + current value), which
is client-side but pure: add `client/test/**/*.test.ts` to the `include` array in the root
`vitest.config.ts`. One glob; the `@shared` alias and node environment already exist, and the module
under test imports no Angular. Smallest honest way to test the rule-1/rule-2 invariants ("the current
value is always present and never disabled") that root cause B is about.

**Tier 3 (do NOT do now -- argued): an Angular TestBed suite.** Needs jsdom +
`@angular/platform-browser/testing` + zone test bootstrapping + custom-element registration. Decisive
argument: **it would not have caught this bug.** Web Awesome components are real custom elements with
shadow DOM, ResizeObserver and upgrade timing, so under jsdom they either fail to upgrade or render
nothing meaningful -- and the bug was a crash DURING embedded-view refresh of a template full of
`wa-*` elements. Buying jsdom buys the appearance of coverage over exactly the surface it cannot render.
The test that WOULD have caught it is a real-browser smoke: load `/risk/admin`, assert no console
error. Genuinely valuable -- but needs Playwright (or `vitest --browser`), a `wrangler dev` fixture, a
logged-in session, and stub Jira/D1 data: a multi-day infra lift attached to a bug fix, when
`fullTemplateTypeCheck` already covers the shipped failure mode. **Defer with a specific
`DEFERRED.md` entry** naming the smoke test, its dependency on a seeded local D1, and the four
runtime defects above as justification -- a costed decision, not an omission.
**Compensating control for this PR:** a manual verification checklist in the PR body enumerating the
five symptom regions from step 1, run against a stored blob that has a Done rule and no `default:true`
rule (the org's actual data shape -- the one that produced all of this).

## 7. Copy fixes

### D -- "Everything else" row vs its caption
The row at `:217-243` is always rendered; numbers come from `fallback() = active()?.fallback ??
HARD_FALLBACK[metric]`. The caption at `:250-255` correctly says there is no catch-all. Fix by
attaching the truth TO THE ROW:
- Label the row by provenance. When `hasFallback()`: "Everything else" + a `Yours` badge. When not:
  "Everything else" + a `Built-in floor` badge, plus a second line in the SAME cell (`.cap` style,
  next to the numbers rather than 40px below): "No catch-all rule is stored, so unmatched tickets use
  the built-in floor. Type a number here to make it yours."
- DELETE the detached paragraph at `:250-255`. A sentence contradicting the row above it is worse
  than no sentence; the row now carries its own explanation.
- Suppress `NO_DEFAULT` from the rendered `warnings()` for the active metric, since the row states it
  inline and better. Do this as a NAMED, COMMENTED filter -- not by weakening the validator, which
  the worker also runs.

### The `simplified()` caption
`simplified()` at `:450` counts across all three metrics (137 -> 47) while the caption at `:97-103`
reads as if it described the visible table.
- Compute `simplifiedByMetric: Record<CutoffMetricId, {before:number; after:number}>` at load; the
  callout shows the ACTIVE metric's numbers.
- When `custom()`: "Simplified this table from 64 rules to 7 -- every column and size still resolves
  to the same thresholds. Nothing is saved until you press Save." (concrete before/after beats a bare
  delta, and it borrows the repairs callout's save disclaimer, which this one is missing and needs).
- When NOT `custom()`: the collapse is display-only and can never be saved -- say so: "The shipped
  defaults are shown simplified (64 rules -> 7); the stored defaults are unchanged."
- If other tabs also collapsed, append ONE clause ("Two other tables were simplified too") rather
  than three callouts.

## 8. Columns fetch (root cause F)
- Extract `loadColumns()` from `ngOnInit`; ALSO call it after a successful save. That is the only
  moment new columns can appear, because `listRiskColumns` (`worker/src/risk/routes.ts:288-291`)
  iterates the SAVED `cfg.boards`.
- Since ticking a board genuinely cannot populate the picker pre-save, SAY SO rather than silently
  doing nothing: when `picked()` contains a board `columnsInfo()?.boards` does not, render an inline
  note in the Scope area -- "Save to load columns for *Sprint B*." Honest, cheap, no server change.
- ADD an `error:` handler to `adminRiskColumns()` -> a `columnsError` signal -> a callout. Today a
  failure leaves `columnsInfo` null, which silently (a) empties the Scope picker and (b) makes
  `pointsMissing()` false, so the "No Story Points field" warning at `:104-111` can NEVER fire and
  nobody learns why the size rules are dead.
- RENDER `RiskColumnsResponse.probeError`. The wire type carries it (`routes.ts:322`) and the client
  ignores it entirely -- `probeError()` in risk-admin is fed only by `adminRiskBoards`. A board that
  degraded to `source:'unavailable'` currently just has no columns, with no explanation.
- Optional/defer: extend the `?probe=<boardId>` response to carry probed column names so a freshly
  ticked board's columns are usable pre-save. Properly correct, but a shared+worker+client change;
  save-then-refetch plus explanatory copy is the shippable version. Record in `DEFERRED.md`.

## 9. User-visible vs internal

**User-visible** (need PR lines and a look at `client/CLAUDE.md`'s editor bullet):
- Rows 2..N, option labels and validation callouts actually render (the headline fix).
- `timeInColumn` opens as 7 collapsed column groups instead of 33 flat rows; idle/cycle unchanged.
- "Add rule" works, seeds from the resolved value for its scope, appears per column group, focuses
  the new input.
- Edits stop being clobbered mid-typing; "repaired N rules"/"simplified N rows" stop re-announcing.
- A row scoped to a Done column now displays its scope; `showDone` changes meaning from disable ->
  offer, and defaults on when a Done rule exists.
- Fallback-row copy and the simplified caption change; the standalone `!hasFallback()` paragraph and
  the `NO_DEFAULT` callout disappear (the fact moves onto the row).
- Rules serialize in DISPLAY order -- can change which of two EQUALLY SPECIFIC tied rules wins for an
  org that has such a pair. The only change here that can alter scoring; call it out explicitly.
- New callouts for a columns-fetch failure and for the columns probe error; a "Save to load columns" note.

**Internal only:** the compiler flag, the four new files and the `shared/` helper moves,
`dom-events.ts`, the `serverCutoffs`/`cutoffs` split, new tests and the vitest include glob.

**Deferred (record in `DEFERRED.md`):**
- `strictTemplates: true` -- pending step 4's measurement, with the count recorded.
- The read-only resolved column x size matrix inside "Test a ticket" (Option B's comprehension value).
- A real-browser smoke test of `/risk/admin` (Tier 3), with its four justifying defects named.
- Carrying probed column names on the `?probe=` response so unsaved board picks populate the picker.

### Critical files
- `client/src/app/risk/cutoffs-editor.component.ts`
- `client/src/app/risk/risk-admin.component.ts`
- `shared/src/risk-cutoffs.ts`
- `client/tsconfig.app.json`
- `worker/test/risk-cutoff-editor.test.ts`
