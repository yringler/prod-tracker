# Deferred work

Features intentionally postponed. Capturing them here so the intent isn't lost.

## Team aggregates

The team-aggregates series (`worker/src/routes/aggregates.ts` →
`dao.teamSeries`) currently shows a fixed window: the last 12 months, starting
no earlier than the first claim in the system. Deferred richer controls:

- **Pagination** of the series — next/previous, one year at a time, so older
  history is reachable without dumping every sprint back to 2015.
- **Range toggle** — rolling last-12-months vs. calendar year.

## Billing (Stripe)

- **Skip polling for lapsed users.** The cron poller
  (`worker/src/cron/poller.ts`) still iterates every stored grant, including
  accounts whose trial expired and never subscribed. Kept in v1 for data
  continuity if they resubscribe (and pending prompts age out anyway). A cost
  optimization is to skip grant-processing for un-entitled accounts — join
  `billing` in `runPoll` and drop non-entitled, non-exempt accounts.
- **Delete the Stripe customer on GDPR erasure.** `eraseAccount` deletes our
  `billing` row but not the Stripe-side customer/subscription. A full erasure
  should also `stripe.customers.del(customerId)` (or redact via the Stripe API)
  before dropping the row, so no PII lingers in Stripe. Deferred because it adds a
  network call to the erasure path (which must stay robust) and Stripe retains
  some records for tax/audit regardless.
- **Webhook IP allowlist.** Defense-in-depth beyond signature verification —
  restrict `/api/billing/webhook` to Stripe's published IP ranges.
