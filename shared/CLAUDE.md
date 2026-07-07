# CLAUDE.md — shared

Agent guide for `shared/`. Read `../CLAUDE.md` (root) first; this file only covers what's
specific to the shared package.

## Orientation

`shared/` is the isomorphic core: TypeScript **types** + **pure domain logic** imported by
**both** the Worker backend (`worker/`) and the Angular client (`client/`). Its defining
rule: it **depends on neither side** — no worker imports, no client imports, no framework
(eslint-enforced, see below). Both sides import it via the `@shared/*` path alias, which
resolves to the `shared/src/index.ts` barrel.

## What lives here

Small on purpose — three source files under `src/`, one test under `test/`.

- **`src/contracts.ts`** — the API/DTO types for `/api/*`, the single source of truth for
  the client↔worker boundary. Request/response shapes only (no logic). Both sides import
  these; **never redefine a wire shape on one side.** Examples: `MeResponse`,
  `UpdateMySettingsRequest`, `PendingRating` / `PendingRatingsResponse`,
  `SubmitRatingRequest` / `SubmitRatingResponse`, `MyRatingsResponse`,
  `TeamAggregateResponse` / `AllTeamsAggregateResponse` (sums only, **no per-account
  fields** — `belowMinSize` privacy flag), `ClaimedTrendsResponse` / `TrendPoint`, admin
  shapes (`Team`, `TeamMembership`, `CreateTeamRequest`, `AssignMembershipRequest`,
  `DoneStatusConfigRequest`, `ConfigResponse`, `FieldCandidatesResponse`, `SetFieldsRequest`),
  push (`PushSubscriptionRequest`, `VapidPublicKeyResponse`), and the generic `ApiError`.

- **`src/domain.ts`** — pure domain constants + functions (only dependency is `date-fns` /
  `@date-fns/utc`). Key exports:
  - `Role`, `StatusCategoryKey`, `StatusTransition` — shared type primitives.
  - `changelogIdGreater(a, b)` — BigInt-safe compare of numeric-string changelog ids; the
    idempotency-by-id primitive (never dedupe on time — see root invariants).
  - `isDoneTransition(toStatus, doneStatusNames, category?)` — name-based done detection,
    falls back to status category when the name set is empty.
  - `sprintForTimestamp(ts, sprints)` + `SprintWindow` — bucket a done-event into the
    sprint whose window contains its timestamp.
  - `ClaimedVsDone`, `computeRatio(claimed, done)` — aggregation series shape + ratio
    (null when done is 0).
  - `MIN_TEAM_SIZE` (= 4) — privacy floor: teams below this return no aggregate at all.
  - `claimCeiling(storyPoints)` / `FALLBACK_CLAIM_CEILING` — upper bound on a self-claim
    (2× points, or the flat fallback for missing/sub-1 estimates).
  - `PENDING_MAX_AGE_MS`, `isStaleTransition(at, now?)` — pending-prompt age-out (fails open
    on an unparseable timestamp).
  - `MAX_DAILY_GOAL`, `DEFAULT_WORKDAY` / `Workday`, `workdayPace(...)` / `WorkdayPace` /
    `PaceState` — daily-goal pacing across the workday (deliberately **wall-clock local**,
    the documented exception to the UTCDate rule).
  - `weekStartOf(iso)` — Monday (UTC) of the ISO week for an ISO/day string; the canonical
    `UTCDate` example (see Conventions).

- **`src/index.ts`** — barrel; re-exports `./domain` and `./contracts`. Import from
  `@shared/domain` / `@shared/contracts` (or the barrel) — never deep-import `dist/`.

## The dependency boundary (load-bearing)

Shared code must stay **pure and isomorphic** so both runtimes can run it:

- **No imports from `worker/` or `client/`**, and no framework/runtime-specific code — no
  Angular, no Cloudflare Workers runtime APIs, no Node-only APIs (unless truly universal). `date-fns` +
  `@date-fns/utc` are the only runtime deps here.
- Enforced by eslint: the `shared/**/*.ts` override in `../.eslintrc.cjs` sets
  `no-restricted-imports` to reject the `**/worker/**`, `**/client/**`, `@worker/*`
  patterns. `tsconfig.json` also sets `"types": []` so no ambient Node/DOM globals leak in.
- When adding code here, keep it framework-free and side-effect-free (pure functions +
  types + constants). If a helper needs a request, a DB handle, or the DOM, it belongs in
  `worker/` or `client/`, not here.

## Conventions

- **Dates & times** — follow the root rule (`../CLAUDE.md`): use `date-fns` for date math,
  and wrap inputs in `UTCDate` from `@date-fns/utc` whenever a computation must be
  timezone-stable. `weekStartOf()` in `domain.ts` is the canonical example; `workdayPace()`
  is the deliberate wall-clock exception (documented in its doc comment). See `../CLAUDE.md`
  for the full convention rather than restating it.

## Testing

- `test/domain.test.ts` runs under **vitest** (`npm test` from the repo root). It covers the
  domain functions — `weekStartOf`, `changelogIdGreater`, `isDoneTransition`,
  `sprintForTimestamp`, `isStaleTransition`, `computeRatio`, `workdayPace`, `claimCeiling`.
- Both sides depend on this logic, so **any new pure calc/constant in `domain.ts` should get
  a unit test here.** (Contracts are types-only; they're checked by `npm run typecheck`.)

## Where to make changes

- **Change the API shape** → edit `contracts.ts`, then update **both** consumers: the Worker
  route (see `../worker/CLAUDE.md`) and the client's `api.service.ts` (see
  `../client/CLAUDE.md`). Changing it in one place only will drift the boundary.
- **Add a pure calc or constant** → add it to `domain.ts` **and** a test in
  `test/domain.test.ts`.

---

Keep this file current as shared's contents or the boundary rule change.
