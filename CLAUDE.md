# CLAUDE.md

Guidance for working in this repo.

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
