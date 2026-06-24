# Deferred work

Features intentionally postponed. Capturing them here so the intent isn't lost.

## Team aggregates

The team-aggregates series (`worker/src/routes/aggregates.ts` →
`dao.teamSeries`) currently shows a fixed window: the last 12 months, starting
no earlier than the first claim in the system. Deferred richer controls:

- **Pagination** of the series — next/previous, one year at a time, so older
  history is reachable without dumping every sprint back to 2015.
- **Range toggle** — rolling last-12-months vs. calendar year.
