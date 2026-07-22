# CLAUDE.md — `client/`

Guidance for the Angular SPA. Read the repo-root [`../CLAUDE.md`](../CLAUDE.md)
and [`../README.md`](../README.md) first for the deploy model, privacy invariant,
and API/domain context — this file summarizes and points, it doesn't duplicate.

## Orientation

- Angular **v21**, **standalone components + signals** (no NgModules, no `zone`-y
  patterns beyond the default change detector). Bootstrapped in `src/main.ts` via
  `bootstrapApplication(AppComponent, appConfig)`.
- Single-page app for **storypoint-tracker**. Built into the Cloudflare Worker's
  static assets and served **same-origin** — the browser talks only to the Worker's
  `/api/*`, **never** to Jira directly (no CORS, no secrets in the bundle). See the
  privacy invariant in [`../README.md`](../README.md).
- All backend calls go through `src/app/api.service.ts`; request/response types are
  imported from `shared/` (`@shared/contracts`, `@shared/domain`) — never redefined
  here. See [`../shared/CLAUDE.md`](../shared/CLAUDE.md).

## File map

Config / bootstrap:
- `src/main.ts` — bootstrap; imports `./webawesome` once for side-effect registration.
- `src/app/app.config.ts` — `ApplicationConfig`: `provideRouter`, `provideHttpClient(withFetch())`, zone change detection with event coalescing.
- `src/app/app.routes.ts` — routes, all **lazy** via `loadComponent`. `''`→`tracker`; `**`→`tracker`.
- `src/app/app.component.ts` — the shell: a `<wa-page>` layout (breakpoint 920px). Its `header` slot holds the `<nav>` row (links, dark-mode `wa-switch`, site picker, avatar chip → settings, sign out); the `navigation` slot holds the same links (via a shared `ng-template`) for the mobile burger drawer, hidden on desktop in `styles.css`. Auth gating and the logged-out marketing/login landing live here too. `/privacy` renders without auth (`PUBLIC_ROUTES`).

Pages — `src/app/pages/` (each a standalone route component):
- `tracker.component.ts` — the core "rate your effort" flow: pending prompts, effort buttons (`claimCeiling`-gated), diary notes, "Done today" strip, daily-goal panel, push enable, dev "add fake item" (localhost only).
- `history.component.ts` — this-week personal history, grouped by local day.
- `aggregates.component.ts` — stats: personal-vs-team claimed trends + per-team claimed-vs-done tables/charts.
- `tools.component.ts` — client-side utilities; currently a copyable LLM standup prompt (`buildStandupPrompt`, pure/exported).
- `settings.component.ts` — profile row + daily-goal editor (`MAX_DAILY_GOAL`).
- `admin.component.ts` — teams, effective-dated memberships, admin appointment, done-status set, custom-field pickers, and per-site notification-channel config (a vendor-agnostic panel driven by each descriptor's `requestedFields`; secret values are write-only). The channel panel also renders the server's non-secret `summary` echo + a "Configured <date>" line and a **Remove configuration** button (`DELETE /api/admin/notifications/{ch}/config`), which turns a channel off site-wide. Uses **Signal Forms** (`@angular/forms/signals`) for the static fields (plain signals for the dynamic channel fields) and `ChangeDetectionStrategy.OnPush`.
- `privacy.component.ts` — public privacy policy (auth-free; keep in sync with actual data practices).

Feature slice — `src/app/risk/` (Sprint Risk Board, lazily loaded at `/risk` via
`risk.routes.ts`; delete the folder + the touchpoints listed in its plan to remove it):
- `risk-board.component.ts` — the risk-ranked triage list (firing metrics only, tier
  stripe, degraded banner, polls while the first snapshot is being built).
- `risk-detail.component.ts` — `wa-dialog` rundown with each ticket's own resolved
  thresholds and per-column time bars.
- `risk-admin.component.ts` — per-site config: boards, refresher account, the
  Fields panel (`<sp-risk-fields>` below + the In Progress status picker, fed by
  `GET /api/admin/risk/fields`), the two structured editors below, and the
  work-schedule JSON box (a visual schedule editor is deferred). Owns save + the
  message banner, renders the server's per-rule `issues` on a 400, and
  client-validates the field entries with the shared `validateFieldEntries`
  before sending. Keeps the same server/draft signal split for the field entries
  (`serverFieldEntries` vs `fieldEntries`) as for cutoffs/composite.
- `fields-editor.component.ts` — `<sp-risk-fields>`, the generic field-mapping
  list that replaced the four fixed slots (Flagged / rejections / Developer /
  Reviewer). Starts empty; "+ Add field" appends a row of label `wa-input`,
  `<sp-field-picker>`, a kind badge once a field is chosen, warn/risk
  `wa-number-input`s (count kind only, seeded 2/4 at pick), a weight control that is
  a `wa-number-input` for count rows (written as 1, mirroring the composite editor's
  "make the default visible" normalize) but an include-in-score `<wa-switch>` for
  flag rows (on↔`weightText='1'`, off↔`'0'`), and remove. The threshold/weight
  number inputs emit on `(input)` (caret-safe — rows echo raw text back via
  `[value]`). Kind is COPIED from the picked `RiskFieldMeta.kind` at
  selection time — the entry, not discovery, owns it from then on. Thresholds are
  kept as TEXT while editing (a half-typed number must not snap to 0) and parsed
  on emit; inline errors come from the shared `validateFieldEntries`, so an error
  shown here is exactly an error the server would 400. Same
  controlled-on-load/uncontrolled-after-mount contract as the cutoffs editor: the
  parent binds its SERVER entries, never the draft from `(entriesChange)`.
- `field-picker.component.ts` — `<sp-field-picker>`, a pencil-opens-a-modal picker
  over ALL the site's Jira fields. The collapsed control is a one-line display of the
  current field (`resolveFieldDisplay`) plus a `pen-to-square` `<wa-button>`; the
  pencil opens a `<wa-dialog>` (the repo's `[open]` + `(wa-after-hide)` idiom, from
  `risk-detail`) holding a `<wa-input>` search box over a plain list of native
  `<button class="option">` rows (`fieldListItems`, capped at `FIELD_PICKER_CAP`).
  Deliberately NOT a `<wa-select>` combobox and NO longer uses `<sp-option-select>`:
  a modal search over hundreds of fields reads far better than a listbox flipping
  over its own filter input, and because the list is plain buttons NONE of the
  wa-select value-presence contract applies — a picked id the filter hides simply
  isn't in the list (the trigger still labels it via `resolveFieldDisplay`, which
  annotates an unrecognized id "not in this site's field list" only when we hold the
  field list). Overflow past the cap is a plain non-interactive hint line ("N more —
  keep typing to narrow"). The dialog is always in the DOM (`[open]` toggled) but its
  list is guarded by `@if (open())` so N closed row-pickers don't each render a list.
  `filterFieldOptions` RANKS matches (exact › prefix › substring, stable) so the cap
  shows the best few. Public contract unchanged (inputs `fields`/`value`/`ariaLabel`,
  output `valueChange`) so `fields-editor`/`pickField` were untouched.
- `cutoffs-editor.component.ts` — `<sp-risk-cutoffs>`, the threshold editor that
  replaced the raw-JSON textarea. A tab per metric, rules **grouped by column**, a
  pinned undeletable "Everything else" fallback rule, a work-hours↔work-days toggle
  (hours are always what's stored), a "Test a ticket" preview, and an Advanced JSON
  import/export. **There is no `<table>`**: a rule is a one-line SENTENCE that
  expands into a vertical form (see `cutoff-row.component.ts`), because a 5-column
  table overflowed a normal viewport to show two number inputs. The two facts the
  old `<thead>` carried ("warn = badge only", "risk = drives the score, value ÷ risk")
  are now a legend above the list. `input()` for
  `cutoffs`/`defaults`/`schedule`/`columns`/`columnsError`/`boardsAwaitingSave`;
  `output()` emits `RiskCutoffs | null` (**null = inherit**, stored NULL). It owns
  the MODEL only (`model`/`custom`/`load`/`patch`/`emit`) and threads state one way
  through inputs — deliberately **no shared service or store**. Four load-bearing
  rules live here:
  - **The parent must bind its `serverCutoffs`, never the draft it gets back from
    `(cutoffsChange)`.** One signal for both made the editor's own emit re-enter its
    own input, whose effect re-runs `load()` — which re-collapses — so every
    keystroke was clobbered, a just-added row was deleted, and "repaired N rules"
    re-announced. `risk-admin.component.ts` keeps `serverCutoffs` (written only on
    load and on a successful save) separate from the `cutoffs` draft.
  - **Collapse runs on LOAD, never on EDIT.** `collapseCutoffs` is reachable from
    exactly three places (the input effect, the follow-defaults transitions,
    `doImport`). Running it on a model holding a new row will delete that row.
  - **Rules serialize in DISPLAY order** (`editorRowsInDisplayOrder`). A column-only
    and a size-only rule are equally specific to `resolveRules`, so array position
    decides — serializing in display order makes what you see the tie-break order.
  - **"Add rule" seeds from `seedRowFor`**, i.e. from what the new row's own scope
    resolves to today, so adding a rule changes no resolution until you type in it.
- `cutoff-row.component.ts` — one rule, as a **summary line that expands into a
  vertical form** (`<sp-cutoff-row>`, an ELEMENT selector now the table is gone —
  it had to be `tr[sp-cutoff-row]` while the host was a `<tr>`). Collapsed it reads
  "In Progress · points 4–5 — warn after 5h 00m, risk after 9h 00m", built from
  `fmtThreshold` so it FOLLOWS the units toggle and can never disagree with the
  control it expands into. Expanded it is one field per row (scope, size, warn, risk,
  remove) — no horizontal layout. Owns the hours↔days conversion, and, on a group's
  column-only rule, the separate LADDER toggle ("7 size rules · warn 1h → 4d 4h").
  The disclosure is **hand-rolled, not `<wa-details>`**: `open() = forcedOpen() ||
  userOpen()`, and `forcedOpen()` (a flagged rule, or the row "Add rule" just made)
  cannot be closed away, which `wa-details` — owning and animating its own `open` —
  fights.
- `cutoff-group.component.ts` — one column's rules (`<sp-cutoff-group>`, likewise an
  element selector since the `<tbody>` went away). The nesting IS the specificity
  order. `timeInColumn` opens as 7 collapsed column groups instead of 33 flat rules;
  `idle`/`cycle` are under the row threshold and open expanded. A group with no
  column-only rule states its fall-through in words rather than rendering an empty
  form that would imply a rule that isn't stored. Its "not on any configured board"
  badge is gated on `columnsKnown` — see the annotation rule under `select-options.ts`.
- `option-select.component.ts` — `<sp-option-select>`, the **single owner of the Web
  Awesome `<wa-select>` contract**; nothing else in the slice touches a select's
  value or options. (1) Never bind a value that isn't in the option list — WA's
  getter filters the bound value against its own option set and returns null
  otherwise, blanking display AND read-back, so a missing value is synthesized and
  annotated. (2) Never mark the selected option `disabled` — same filter — enforced
  structurally: options carry no `disabled` field. (3) "Not offered" is expressed by
  OMITTING an option (that is what `showDone` now does: it **offers** Done columns
  rather than greying them out, and defaults ON when the table holds a Done rule).
  (4) Read-back is normalized once and REJECTED rather than coerced
  (`parseSizeValue` returns `undefined` for a non-bucket; `Number(null) === 0` was
  the original bug). Its consumers are now the cutoffs column/size/status selects
  only; the listbox-open machinery (`isOpen`/`openListbox()`/`[attr.open]`/
  `wa-show`/`wa-hide`) and the `placement` input were retired when the field picker
  stopped using it (the field picker is now a modal, not a select).
- `select-options.ts` — pure, Angular-free builders. `SelectOption[]` for the
  wa-select pickers (`columnOptions`/`sizeOptions`/`statusOptions`/
  `ensureValuePresent`/`hasDoneColumnRule`/`boardColumnsKnown`) PLUS the field
  picker's own helpers (`fieldLabel`/`resolveFieldDisplay`/`fieldListItems`, over
  `filterFieldOptions`). Unit tested in `client/test/select-options.test.ts`.
  **The field picker is a modal list, not a `<wa-select>`**, so its old
  `allFieldOptions`/`FIELD_FILTER_CAP` (which existed only to satisfy the wa-select
  value-presence contract with a leading `''` "Pick a field…" option and a small
  filtering cap) are GONE. In their place: `fieldLabel(f)` is the one "name (id)"
  form; `resolveFieldDisplay(value, all)` is the trigger's one-line display (found →
  "name (id)"; unknown id → the bare id, noted "not in this site's field list" only
  when the list is held; `''` → empty); `fieldListItems(fields, query, selectedId,
  cap?)` is the ranked, `FIELD_PICKER_CAP`-capped list with `{ items, overflow }` —
  no value-presence defense, a hidden selected id just isn't listed. `filterFieldOptions`
  ranks matches (exact › prefix › substring, stable) so the cap shows the best few.
  **For the remaining wa-select pickers, "None"/"Default" is an OPTION, never the
  absence of one.** `statusOptions` leads with `Default — <shipped default>`, because
  a bound `''` with no `''` option is exactly the value WA filters away.
  **An option's `note` is a CLAIM, and is only made when we can support it.**
  `ensureValuePresent` must always make the bound value selectable (rule 1), but its
  note is optional: `columnOptions` attaches "not on any configured board" only when
  `boardColumnsKnown(boards)` — one board with at least one column. A board whose
  probe failed ships `columns: []`, so counting boards is not evidence. Without this
  a site whose columns fetch returned nothing had EVERY rule annotated "not on any
  configured board", which is a statement about our ignorance, not about the column.
  The same gate drives the group header's `wa-badge` (`columnsKnown` input) and the
  editor's `noColumnsNote()` callout, which names the empty state (no boards saved
  yet vs. saved boards that have not reported columns) instead of leaving the Scope
  picker silently empty.
- `dom-events.ts` — `targetValue` / `targetChecked` / `selectValue`, the one place a
  value is read off a DOM or custom element. Pure functions, no class, no DI.
- `composite-editor.component.ts` — `<sp-risk-composite>`, the power-mean `p` as a
  labeled slider plus the four core weights, where `0` renders as an explicit
  **Excluded** badge (weight ≤ 0 drops the metric entirely; an *absent* weight
  defaults to 1 — not the same thing). `normalize()` copies only the four known
  ids, which is what strips a legacy `rejections` weight on load. Mapped-field
  weights appear as READ-ONLY rows (via the `fields` input, bound to the DRAFT
  entries) so the whole score story reads in one place; they're edited in the
  Fields panel and are not governed by the built-in-defaults switch.
- `impact-preview.component.ts` — `<sp-risk-impact>`, the anti-footgun that answers
  "what would these settings do?": per saved board, "12 at risk / 9 warning / 40
  healthy" with a signed delta per tier, a Now/After composition bar, and a sample
  of the tickets that change tier. It debounces (500 ms) a `POST
  /api/admin/risk/preview` — a server-side re-score of the STORED snapshots, so no
  scoring happens here and it costs no Jira calls. It renders the server's
  `scheduleStale` caveat verbatim (the preview covers thresholds and weights, never
  a schedule edit) and reports a board with no snapshot instead of hiding it. Tier
  hues are the board's own `--risk`/`--warn`/`--done`; those are status colors, too
  close in light mode to carry meaning by hue, so every tile and verdict pairs the
  color with an icon and a word.
- `format.ts` — pure display helpers (`fmtWorkHM`, `fmtThreshold` — the same number
  the units toggle is showing, so the cutoff editor's collapsed summaries and its
  inputs cannot disagree — firing-metric pills, band variants).
  `firingMetrics(t, fields)` takes the SNAPSHOT'S `fields ?? []` and appends the
  mapped-field pills (count → "3 Rejections", flag → the label) after the core
  four; every `t.fieldMetrics` read is null-guarded, so a pre-fields snapshot
  degrades to core pills only (tier stripe stays correct — it's stored).
  `HOURS_PER_WORKDAY` now re-exports `WORK_HOURS_PER_DAY` from `@shared/risk-cutoffs`.
  **No SCORING of ticket data happens client-side** — the snapshot carries every
  value, band and threshold (see `worker/src/risk/`). The narrowed rule, since the
  cutoffs editor landed: *config-editing math is shared* — the editor imports
  `resolveCutoff`/`validateCutoffs`/`toEditorModel` from `@shared/risk-cutoffs` and
  runs the **server's own** functions, precisely so its "which rule wins" preview
  cannot drift from the scorer. Read-path components still recompute nothing.

UI / charts — `src/app/ui/` (reusable):
- `chart.component.ts` — `<sp-chart>`, thin Chart.js wrapper owning the canvas/lifecycle; registers only the line-chart pieces (no `TimeScale`). Updates in place on config swap (avoids replaying the entry animation).
- `chart-theme.ts` — shared `ChartOptions` builders (`categoryOptions`, `dateLineOptions`, `timeOfDayOptions`) + `themeColors()` reading CSS vars at runtime.
- `line-chart.component.ts` — `<sp-line-chart>`, per-sprint claimed-vs-done with a raw/ratio toggle.
- `claimed-trends.component.ts` — `<sp-claimed-trends>`, 30-day + 6-month personal-vs-team line charts.
- `goal-progress.component.ts` — `<sp-goal-progress>`, daily-goal meter + milestones + pace copy + cumulative time-of-day line (`workdayPace` from shared).
- `avatar.component.ts` — `<sp-avatar>`, round image with initials fallback.
- `notification-channels.component.ts` — `<sp-notification-channels>`, the settings
  panel. Since the admin owns provisioning, the user surface is a **toggle per
  channel** (`<wa-switch>` → `PUT /api/notifications/{ch}/enabled`), not
  Connect/Disconnect: `enabled` and the identity `status` are orthogonal, so turning a
  channel on when the reply says the channel still needs an identity opens the existing
  setup panel automatically, and "Forget my …" (the old Disconnect) only appears when
  the channel is off but still linked. **The identity prompt is gated on the
  descriptor's `requiresUserIdentity`** (`needsIdentity()`), not on `status.linked`
  alone: an adapter that declares `requiresUserIdentity: false` needs nothing from the
  user, so enabling it reads "On" and opens no setup panel. Absent → treated as `true`
  (the conservative default; both shipped adapters declare it). A failed toggle resets
  the **uncontrolled** `<wa-switch>` element's `.checked` directly and shows
  `actionError` — re-rendering cannot fix it, because the bound expression never
  changed. The `@switch (step.kind)` setup panel — including
  its `assertNever` exhaustiveness guard and the sandboxed `embed` — is untouched and
  must stay that way. `CUSTOM_ELEMENTS_SCHEMA` component: the switch follows the
  repo's existing `<wa-switch>` usage (`[checked]` property binding, `(change)` with a
  template ref rather than a `$event.target` cast in the template).

Services — `src/app/` (all `@Injectable({ providedIn: 'root' })`):
- `api.service.ts` — typed client for every `/api/*` endpoint; returns RxJS `Observable`s.
- `auth.service.ts` — session state (`me`, `loaded`, `isAdmin` signals); `login`/`logout`/`switchSite`, local `me` patching.
- `theme.service.ts` — light/dark `theme` signal; `effect` toggles `wa-dark`/`wa-light` on `<html>`, persists to `localStorage`, updates `theme-color`.
- `push.service.ts` — registers `sw-push.js`, requests notification permission, subscribes via VAPID key, POSTs the subscription server-side.

Other `src/` files:
- `webawesome.ts` — central Web Awesome registry (side-effect imports; see below).
- `sw-push.js` — plain-JS Web Push service worker (NOT in the Angular bundle; shipped as an asset). Shows the "rate this" notification and routes clicks to `/tracker?pending=…`.
- `manifest.webmanifest` — PWA manifest (standalone display).
- `index.html` — host page (`<sp-root>`), `<base href="/">`, `<link rel="manifest">`, and an inline boot script that applies the saved/OS theme class before first paint (kept in sync with `ThemeService`). **The `<base href="/">` is load-bearing:** the CLI emits relative bundle URLs, so without it a direct load of any route deeper than one segment (`/risk/admin`, or even `/risk/` with a trailing slash) resolves `main-*.js` against the route path, hits the Worker's SPA fallback, gets `index.html` back, and the ES module fails its MIME check — a blank page with a green build, reachable only by in-app navigation. Pinned by `client/test/index-html.test.ts`.
- `styles.css` — global styles: per-theme brand palette CSS vars (`--accent`/`--claimed`/`--done`/…) and a Web Awesome token bridge mapping `--wa-color-*` onto them.

## Conventions & patterns

### Template type checking (load-bearing)

`client/tsconfig.app.json` sets **`fullTemplateTypeCheck: true`** and
**`strictTemplates: true`** under `angularCompilerOptions`. Do not remove them.

- Without `fullTemplateTypeCheck`, Angular runs only *basic* template checking:
  top-level binding expressions are checked, but expressions inside an **embedded
  view** (`@if` / `@for` / `ng-template`) are **not**. That hole shipped a runtime
  `TypeError: ctx.String is not a function` inside `@for` in the cutoffs editor,
  blanking every row after the first, with a green build. The flag turns that whole
  bug class — any template expression referencing a JS global or a member the
  component class doesn't have — into a **build failure**, and `wrangler.toml`'s
  `[build]` already runs `npm run build:client` before every dev/deploy, so the gate
  was wired; only the flag was missing.
- **Never satisfy this by adding `readonly String = String` (or any equivalent
  alias) to a component class.** It fixes the build and re-hides the entire bug
  class — `risk-board.component.ts` carried exactly that field, which is why its two
  `String(...)` sites did not error. Add a real typed member instead
  (`sizeValue()`, `weightText()`, `boardValue()`).
- `strictTemplates` was measured before adoption: 4 errors repo-wide, all one real
  defect (a `<wa-input>`'s `value` is `string | null`), all fixed by widening the
  parameter type — no cast, no `$any`.

### Standalone + signals
- Every component is `standalone: true` with explicit `imports`. No NgModules anywhere.
- **State is signals**: `signal()` for local state, `computed()` for derived views,
  `effect()` for side-effects (see `theme.service.ts`). Newer components use
  `input.required<T>()` / `input()`; older ones use `@Input()` setters that write
  into a backing `signal` (e.g. `goal-progress`, `line-chart`). `admin.component.ts`
  uses **Signal Forms** (`form`, `required` from `@angular/forms/signals`) + `OnPush`.
- RxJS is used only at the HTTP boundary (`HttpClient` `Observable`s) and for router
  events; convert to signals in the component. `push.service.ts` uses
  `firstValueFrom` to await one-shot calls.

### API service
- `ApiService` injects `HttpClient` and exposes one method per endpoint, each typed
  with `shared/` contract types (`import type { … } from '@shared/contracts'`).
  The `@shared/*` path alias → `shared/src/*` (see `tsconfig.base.json`).
- Components call these and `.subscribe(...)`, handling `next`/`error` to flip a
  `loading`/`busy` signal. Auth/session is **cookie-based** and server-side — no
  tokens in the client. `AuthService.load()` calls `/api/me`; a failed call means
  logged-out (shows the landing page). There is no HTTP interceptor.
- **Never** add a direct Jira call or redefine a contract type here — extend
  `shared/` and add a method to `ApiService`.

### Web Awesome components
- The repo has a **`webawesome` skill** — consult it for component APIs/usage before
  hand-rolling UI. The library is `@awesome.me/webawesome`.
- Registration is **centralized** in `src/webawesome.ts`: importing a component's
  module is a side-effect that defines its custom element. `main.ts` imports that
  file once. **To use a new `<wa-*>` component, add its import there** — templates
  aren't statically analyzed, so an unregistered element silently no-ops (and the
  bundler could tree-shake it).
- Components that use `<wa-*>` in their template set `schemas: [CUSTOM_ELEMENTS_SCHEMA]`.
- Web Awesome's base CSS is loaded via `angular.json` `styles`
  (`@awesome.me/webawesome/dist/styles/webawesome.css`); `styles.css` bridges
  `--wa-color-*` role tokens onto the app's brand palette so `<wa-*>` matches the app.

### Charts (Chart.js)
- All charts go through `<sp-chart>` (`chart.component.ts`), fed a `ChartConfiguration`
  built by a `computed()` in the owning component. Options come from `chart-theme.ts`.
- Colors are read from CSS custom properties at runtime via `themeColors()`, so
  charts follow the active theme. Chart-building `computed`s call `this.theme.theme()`
  once to re-run when the theme toggles.
- No Chart.js `TimeScale`/date adapter — time axes are **linear over epoch-ms** with
  ticks/tooltips formatted by **date-fns** (UTC via `@date-fns/utc` for stored
  timestamps; local time only for the "my day" goal chart — see `chart-theme.ts`
  comments). Follow date/time rules in [`../CLAUDE.md`](../CLAUDE.md).
- For any **new** chart, consult the repo's **`dataviz` skill** for palette/spec
  guidance, then reuse `<sp-chart>` + a `chart-theme.ts` options builder.

### Theming & styling
- `ThemeService` owns the light/dark signal; the `wa-dark`/`wa-light` class on
  `<html>` selects the palette in `styles.css`. Keep `THEME_COLOR` in the service,
  the `<meta name="theme-color">` values, and the `--bg` vars in `styles.css` in sync.
- Styling is global CSS (`styles.css`) plus small per-component `styles: [...]`.
  Prefer the palette vars (`--accent`, `--claimed`, `--done`, `--muted`, `--line`,
  `--panel`, `--ink`) and Web Awesome tokens over hard-coded colors.

### PWA / push
- `push.service.ts` + `sw-push.js` + `manifest.webmanifest`. The service worker is
  shipped as a static asset (listed in `angular.json` `assets`), **not** bundled by
  Angular — keep it plain JS. VAPID keys come from the Worker
  (`/api/push/vapid-public-key`); the cron poller sends the notifications.

## Common commands

Run from the repo root:
- `npm run build:client` — `cd client && ng build --configuration production` →
  `client/dist/client/browser` (the Worker's asset dir per `wrangler.toml`).
- `npm run dev` — `wrangler dev`; its `[build]` command builds the client first, so
  **dev is normally driven through the Worker** (serves API + SPA same-origin), not
  `ng serve`. `npm run deploy` builds the client then `wrangler deploy`.
- `npm run typecheck` — root + shared TS (client is type-checked as part of the build).

There is no Angular test suite (no TestBed, no jsdom — see `DEFERRED.md` for the
argued reason). The root `vitest.config.ts` `include` does carry
**`client/test/**/*.test.ts`** for **pure, Angular-free** client modules only
(today: `src/app/risk/select-options.ts`); the `@shared` alias and node environment
already cover it, no extra config. Anything semantically risky should move to
`shared/` and be tested there instead. Everything else lives in `worker/test/`.

## Where to make changes

- **Add a page** → new component in `src/app/pages/`, add a lazy route in
  `app.routes.ts`, and a nav link in `app.component.ts` (gate on `auth.isAdmin()` if admin-only).
- **Add an API call** → add a typed method to `src/app/api.service.ts` using a
  `shared/` contract type; add the endpoint in `worker/` too (see
  [`../worker/CLAUDE.md`](../worker/CLAUDE.md)).
- **Add a chart** → build a `ChartConfiguration` in a `computed()`, render via
  `<sp-chart>`, and add/reuse an options builder in `src/app/ui/chart-theme.ts`.
- **Add a `<wa-*>` component** → register it in `src/webawesome.ts`; add
  `CUSTOM_ELEMENTS_SCHEMA` to the host component.
- **Change nav / shell / auth gating** → `src/app/app.component.ts`.
- **Change theme/palette** → `theme.service.ts` + `styles.css` (keep theme-color in sync).

---
Keep this file up to date as the client structure and conventions change.
