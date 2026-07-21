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

Small on purpose — a handful of source files under `src/`, one test under `test/`.

- **`src/contracts.ts`** — the API/DTO types for `/api/*`, the single source of truth for
  the client↔worker boundary. Request/response shapes only (no logic). Both sides import
  these; **never redefine a wire shape on one side.** Examples: `MeResponse`,
  `UpdateMySettingsRequest`, `PendingRating` / `PendingRatingsResponse`,
  `SubmitRatingRequest` / `SubmitRatingResponse`, `MyRatingsResponse`,
  `TeamAggregateResponse` / `AllTeamsAggregateResponse` (sums only, **no per-account
  fields** — `belowMinSize` privacy flag), `ClaimedTrendsResponse` / `TrendPoint`, admin
  shapes (`Team`, `TeamMembership`, `CreateTeamRequest`, `AssignMembershipRequest`,
  `DoneStatusConfigRequest`, `ConfigResponse`, `FieldCandidatesResponse`, `SetFieldsRequest`),
  push (`PushSubscriptionRequest`, `VapidPublicKeyResponse`), and the generic `ApiError`
  (+ `ApiIssue`, the feature-neutral "which field was wrong" shape that `ApiError.issues`
  carries — `RiskConfigIssue` narrows it; contracts.ts deliberately imports no feature types).

- **`src/notifications.ts`** — the vendor-NEUTRAL notification vocabulary + wire shapes,
  imported by both the worker's adapters and the settings/admin UI. `SetupStep` (the
  exhaustive setup-step vocabulary the client renders with a `@switch`; deliberately no
  `html` kind) and `SetupInstructions`; `NotifierDescriptor` (`requestedFields` = the
  ADMIN's per-org config field names, write-only; `requiresUserIdentity` +
  `identityPrompt` = the ONE thing the channel needs from the USER, phrased so the client
  stays vendor-free); `LinkStatus`; and the wire shapes — `ChannelListItem`, whose
  `status` (do I have an identity?) and `enabled` (do I want it?) are **orthogonal**,
  `SetChannelEnabledRequest`/`Response` (the per-user opt-in toggle), `SetupSubmission`,
  and the admin `AdminChannelConfigItem` (`configured` + the audit echo
  `configuredAt`/`configuredBy` + `summary`, an **adapter-declared allow-list of
  non-secret values only** — secrets never appear there) / `ConfigureChannelRequest`.

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
  - `DAY_BOUNDARY_HOUR` (= 3), `trackerDayKey(d)` / `trackerDayStart(d)` /
    `isTrackerToday(d, now)` — the personal reflective day starts at **3AM local**, not
    midnight (a 2AM claim folds into the prior day). Deliberately **wall-clock local**,
    like `workdayPace` (not the UTCDate rule). Used only by the client's local
    "today/yesterday" & per-day groupings — the UTC trend buckets don't use it.

- **`src/risk.ts`** — WIRE TYPES for the Sprint Risk Board (`RiskBand`, `RiskMetricId`,
  `RiskCutoffs`, `RiskWorkSchedule`, `RiskTicket`, `RiskBoardSnapshot`, `RiskConfigIssue`,
  `RiskColumnsResponse`, the impact-preview shapes (`RiskPreviewRequest` /
  `RiskPreviewBoard` / `RiskPreviewResponse` — the preview's arithmetic is
  server-side in `worker/src/risk/logic/preview.ts`; only its wire shape is here),
  and the `/api/risk/*` + `/api/admin/risk/*` request/response
  shapes). The board's **scoring** logic still does not live here: it has exactly one
  consumer, the Worker (`worker/src/risk/logic/`), and the snapshot ships every computed
  value the client needs. Delete this file (and its barrel line) with the feature.

- **`src/risk-cutoffs.ts`** — the ONE documented exception to "risk logic has a single
  consumer": the **config-editing** half of the cutoff tables, imported by both the
  Worker (validation on `PUT /api/admin/risk/config`, and `logic/scoring.ts` re-exports
  the resolution primitives from here) and the client (`app/risk/cutoffs-editor.component.ts`).
  The read path is untouched — the client still never scores a ticket. The narrowed rule
  is: **no scoring of ticket data client-side; config-editing math is shared.** Moving
  `resolveCutoff` here is what makes the editor's "which rule wins" preview provably
  identical to the server's.
  - Resolution: `FIB_BUCKETS`, `sizeBucket`, `resolveCutoff`, `resolveRules`,
    `HARD_FALLBACK`, `Cutoff`, `CutoffMetricId`.
  - Vocabulary: `CUTOFF_METRICS` (labels kept identical to the board's `METRIC_LABELS`),
    `SIZE_BUCKET_LABELS` (buckets rendered as the point RANGES they capture, generated
    from `FIB_BUCKETS` so they can't drift), `WORK_HOURS_PER_DAY`, `workHoursPerWeek` /
    `workHoursPerDay` / `scheduleDaysSummary`.
  - Validation: `validateCutoffs(cutoffs, ctx?)` → `{ errors, warnings }` of
    `RiskConfigIssue`. **Errors block the save; warnings are advisory.** `ctx` is optional
    so the worker runs the context-free subset and the client the full set with board
    columns loaded. It is *stricter* than the boolean validator it replaced — see its
    BACK-COMPAT CAVEAT comment.
  - Transforms: `toEditorModel` / `fromEditorModel` (with auto-repair of the three newly
    rejected cases), `collapseRedundantRules` / `collapseCutoffs`, `equivalentRules`,
    `ambiguousPairs`, `sortRowsForDisplay`. `collapseRedundantRules` is behavior-preserving
    **by construction**: it drops a rule only if `equivalentRules` proves the result
    resolves identically over every (column, bucket) pair — not by pattern-matching.
  - Editor MUTATIONS + grouping (pure `EditorMetricModel` math, deliberately here and
    not in the component, so it is testable with zero new infra):
    `editorRowKey`, `editorRowsInDisplayOrder`, `parseSizeValue`, `seedRowFor`,
    `applyScopeChange`, `groupRowsByColumn` / `CutoffRowGroup`, `NO_SUCH_COLUMN`.
    Three of these carry invariants worth knowing before touching them:
    - `parseSizeValue` **rejects** (`undefined`) rather than coerces — the caller must
      return early. `Number(null) === 0` is not a `SizeBucketKey`, and a
      `<wa-select>` genuinely hands back `string | null | string[]`.
    - `seedRowFor` makes **adding a rule change no resolution until you type in it**:
      a new rule starts at whatever its own scope resolves to today, not at the
      table's fallback (which silently re-bands a column that already had a rule).
    - `editorRowsInDisplayOrder` is why the editor serializes in display order: a
      column-only and a size-only rule are EQUALLY specific to `resolveRules`, so
      array position decides. USER-VISIBLE — it can change which of a tied pair wins.
    Keep UI vocabulary (`SelectOption` builders) client-side, in
    `client/src/app/risk/select-options.ts`.
  - Delete this file (and its barrel line) with the feature.

- **`src/index.ts`** — barrel; re-exports `./domain`, `./contracts`, `./notifications`, `./risk` and `./risk-cutoffs`. Import from
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
- `test/risk-cutoffs.test.ts` — one case per validation rule (errors vs warnings), the
  editor-model round-trip + auto-repairs, `collapseRedundantRules` equivalence and
  idempotence, `ambiguousPairs`, the bucket labels, the work-hours derivations, and
  the editor-mutation half: `parseSizeValue`'s rejections, `seedRowFor`'s
  "adding a rule changes no resolution" invariant (asserted exhaustively over the
  probe space), `groupRowsByColumn`'s partition/order, `applyScopeChange`'s refusal
  to duplicate a scope, and the display-order round trip on a deliberate tie.
  Note it uses **local fixtures**, not `DEFAULT_CUTOFFS`/`DEFAULT_SCHEDULE`: those live in
  `worker/src/risk/logic/defaults.ts` and shared/ may not import worker/. The assertions
  over the real shipped tables are in `worker/test/risk-cutoff-editor.test.ts`.
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
