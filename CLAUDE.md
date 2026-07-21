# CLAUDE.md — root

Agent-facing operational guide for **storypoint-tracker**. Read this first, then the
per-folder `CLAUDE.md` for the area you're touching.

## Orientation

A personal/peer story-point **effort** tracker on top of Jira Cloud. Developers
self-rate the effort they put into each ticket (0/25/50/100%) as it moves through
statuses; the app graphs **team-level** claimed-effort points against real Jira done
points per sprint. It is deliberately **not** a surveillance tool (see the privacy
invariant below).

**Deploy model: one Cloudflare Worker.** The Worker serves the JSON API **and** ships
the built Angular SPA as its static assets — same origin, no CORS, a single
`wrangler deploy`. See `README.md` for the human narrative (detection, aggregation,
roles, OAuth scopes, multi-site).

## Repo map

Each area has its own `CLAUDE.md` — read it before editing there.

| Folder | What it is | Guide |
| --- | --- | --- |
| `shared/` | TS types + pure domain logic imported by both sides; depends on **neither** client nor worker (eslint-enforced). | `shared/CLAUDE.md` |
| `worker/` | Cloudflare Worker backend — hand-rolled `route()` dispatcher in `src/index.ts` (no Hono), plus `routes/`, `jira/`, `cron/`, `db/`. Privacy enforced in `db/dao.ts`. | `worker/CLAUDE.md` |
| `client/` | Angular SPA (standalone components, signals); built into the Worker's static assets. | `client/CLAUDE.md` |
| `worker/src/risk/` | Sprint Risk Board — a self-contained, deletable feature (own `risk_*` tables, own cron job, own routes, lazy `client/src/app/risk/` UI). IT MUST BE EASY TO DELETE. | `worker/CLAUDE.md` |
| `migrations/` | Versioned, idempotent D1 SQL migrations. | `migrations/CLAUDE.md` |
| `scripts/` | One-off SQL maintenance scripts (run via `wrangler d1 execute`). | — |

Root config: `wrangler.toml` (Worker + D1 + assets + cron), `tsconfig.json` (Worker +
shared, the file wrangler/editors auto-discover), `tsconfig.base.json` (shared compiler
settings + `@shared/*` path), `.eslintrc.cjs` (import-boundary rules).

## Common commands

Run from the repo root (script names are exact — see `package.json`).

| Command | Does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` for the Worker+shared project **and** the shared project (strict). |
| `npm test` | Vitest, one run (`test:watch` for watch mode). |
| `npm run lint` | ESLint over all `.ts`. |
| `npm run dev` | `wrangler dev` — serves API **and** SPA locally. |
| `npm run build:client` | `cd client && ng build --configuration production` → `client/dist/client/browser`. |
| `npm run deploy` | `wrangler deploy`. |
| `npm run db:migrate` | Apply `migrations/` to the **local** D1. |
| `npm run db:migrate:remote` | Apply migrations to the **remote/production** D1. |
| `npm run db:migrate:new <name>` | Scaffold a new migration file. |
| `npm run db:migrate:list` | List local migration state. |
| `npm run db:reset:local` | Wipe local D1 state and re-migrate from scratch. |

**`wrangler dev` and `wrangler deploy` run `npm run test && npm run build:client` first**
— the `[build]` command in `wrangler.toml` is the single source of "how to build" (it
also drives Workers Builds). A failing test or client build blocks dev/deploy.

## Conventions

### Dates & times
- Use **date-fns** for date/time math (parsing, comparison, bucketing, formatting)
  rather than hand-rolled `Date` arithmetic, wherever it makes the code clearer.
  It's already a dependency.
- Timestamps in the DB (`rated_at`, `transitioned_*`, membership `effective_*`)
  are **UTC ISO strings**. When a computation must be timezone-stable (it nearly
  always must), wrap the input in `UTCDate` from **`@date-fns/utc`** so date-fns
  operates in UTC regardless of the runtime's local zone — e.g. `weekStartOf()`
  in `shared/src/domain.ts`.

### Module boundaries (eslint-enforced, `.eslintrc.cjs`)
- **`shared/` depends on nothing** from `client/` or `worker/`. It's pure types +
  domain logic, imported by both sides.
- **`client/` must never import `worker/`** — keep DB drivers and secrets out of the
  browser bundle. Dependency arrows point inward.
- Import shared code via the `@shared/*` path alias (mapped in both tsconfigs).

### TypeScript
- ESM throughout (`"type": "module"`). Strict mode plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
  (`tsconfig.base.json`).
- `@typescript-eslint/no-explicit-any` is an **error** — no `any`.

## Load-bearing invariants an agent must NOT break

Short pointers — read the referenced code/tests before changing anything nearby.

- **Privacy invariant.** Only `getRatingsForOwner(ownerId)` returns individual rating
  rows (filtered `WHERE rater_account_id = ?`); aggregate methods sum-only, take no
  rater filter, expose no account column; a `MIN_TEAM_SIZE` floor suppresses
  small-team aggregates. Enforced in `worker/src/db/dao.ts`, tested in
  `worker/test/privacy.test.ts`. See `worker/CLAUDE.md` and README "Privacy invariant".
- **Idempotency is by changelog entry id, not time.** Overlapping poll windows are
  safe because each transition is counted once by BigInt-safe id comparison
  (`shared/src/domain.ts:changelogIdGreater`, `worker/src/jira/changelog.ts`; cursor
  in `issue_state`). Never dedupe on timestamps.
- **Story Points / Sprint custom fields are discovered, never hardcoded**
  (`worker/src/jira/fields.ts`); ambiguity is logged, not guessed. Don't inline a
  `customfield_*` id.
- **OAuth refresh tokens rotate** — every refresh persists the new token and discards
  the old (`worker/src/jira/client.ts`); the token is stored once per account and
  shared across per-site clients. Don't cache/reuse a stale token.
- **Scopes are frozen at consent, and scope drift is detected.** Changing
  `OAUTH_SCOPE_LIST` (`worker/src/env.ts`) does NOT invalidate existing grants —
  they keep minting tokens with the old scopes, so the new calls 401 with no
  `invalid_grant` to notice. `worker/src/jira/scopes.ts` diffs the access token's
  own `scope` claim and the client raises `ScopeDriftError` (a subclass of
  `ReauthRequiredError`, so every existing dead-grant path handles it) after
  setting `needs_reauth`. It **fails open** on an unparseable token. Any scope
  change forces all users through one re-authorize — and the scope must be enabled
  on the app in the Atlassian developer console, not just listed in code. Jira
  Software honors no classic scopes: see README "Atlassian app setup".
- **Done events bucket by changelog timestamp**, into the sprint whose window contains
  that time — not the issue's current sprint.
- **Schema mirroring:** `worker/src/db/schema.sql` mirrors the full migrated schema and
  backs the tests. Any migration change must keep it in sync — see `migrations/CLAUDE.md`.

## Testing

- **Vitest** (`npm test`). Coverage lives in `worker/test/` and includes changelog
  idempotency, the privacy invariant, DAO behavior, domain logic, admin guards, and
  multi-site token handling.
- Tests run against `worker/src/db/schema.sql` (via better-sqlite3), so keep that schema
  current with migrations or tests drift from reality.
- `npm test` is part of the `wrangler.toml` `[build]` step, so it also gates every
  `dev`/`deploy`.

## Deferred work

- See `DEFERRED.md` for intentionally postponed features.

---

## Keep these files current

This file and the per-folder `CLAUDE.md` (`client/CLAUDE.md`, `worker/CLAUDE.md`,
`shared/CLAUDE.md`, `migrations/CLAUDE.md`) are the contract for how to work here. When
you change conventions, commands, structure, or a load-bearing invariant, **update the
relevant `CLAUDE.md` in the same change** so the guidance never lies to the next agent.
