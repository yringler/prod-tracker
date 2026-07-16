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
- `admin.component.ts` — teams, effective-dated memberships, admin appointment, done-status set, custom-field pickers, and per-site notification-channel config (a vendor-agnostic panel driven by each descriptor's `requestedFields`; secret values are write-only). Uses **Signal Forms** (`@angular/forms/signals`) for the static fields (plain signals for the dynamic channel fields) and `ChangeDetectionStrategy.OnPush`.
- `privacy.component.ts` — public privacy policy (auth-free; keep in sync with actual data practices).

UI / charts — `src/app/ui/` (reusable):
- `chart.component.ts` — `<sp-chart>`, thin Chart.js wrapper owning the canvas/lifecycle; registers only the line-chart pieces (no `TimeScale`). Updates in place on config swap (avoids replaying the entry animation).
- `chart-theme.ts` — shared `ChartOptions` builders (`categoryOptions`, `dateLineOptions`, `timeOfDayOptions`) + `themeColors()` reading CSS vars at runtime.
- `line-chart.component.ts` — `<sp-line-chart>`, per-sprint claimed-vs-done with a raw/ratio toggle.
- `claimed-trends.component.ts` — `<sp-claimed-trends>`, 30-day + 6-month personal-vs-team line charts.
- `goal-progress.component.ts` — `<sp-goal-progress>`, daily-goal meter + milestones + pace copy + cumulative time-of-day line (`workdayPace` from shared).
- `avatar.component.ts` — `<sp-avatar>`, round image with initials fallback.

Services — `src/app/` (all `@Injectable({ providedIn: 'root' })`):
- `api.service.ts` — typed client for every `/api/*` endpoint; returns RxJS `Observable`s.
- `auth.service.ts` — session state (`me`, `loaded`, `isAdmin` signals); `login`/`logout`/`switchSite`, local `me` patching.
- `theme.service.ts` — light/dark `theme` signal; `effect` toggles `wa-dark`/`wa-light` on `<html>`, persists to `localStorage`, updates `theme-color`.
- `push.service.ts` — registers `sw-push.js`, requests notification permission, subscribes via VAPID key, POSTs the subscription server-side.

Other `src/` files:
- `webawesome.ts` — central Web Awesome registry (side-effect imports; see below).
- `sw-push.js` — plain-JS Web Push service worker (NOT in the Angular bundle; shipped as an asset). Shows the "rate this" notification and routes clicks to `/tracker?pending=…`.
- `manifest.webmanifest` — PWA manifest (standalone display).
- `index.html` — host page (`<sp-root>`), `<link rel="manifest">`, and an inline boot script that applies the saved/OS theme class before first paint (kept in sync with `ThemeService`).
- `styles.css` — global styles: per-theme brand palette CSS vars (`--accent`/`--claimed`/`--done`/…) and a Web Awesome token bridge mapping `--wa-color-*` onto them.

## Conventions & patterns

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

There is no standalone client test suite; tests live in `worker/` (vitest).

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
