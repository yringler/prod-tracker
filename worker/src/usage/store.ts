// Persistence for the D1 usage meter (./meter.ts). The ONLY code that touches
// `usage_stats`, always through the RAW (unmetered) binding.
//
// Cost model: writing a stats row per request would itself be a write per request
// — the risk board alone polls every 20 s per open tab. So tallies accumulate in
// module scope (per isolate) and flush at most once per FLUSH_INTERVAL_MS per
// isolate, plus unconditionally at the end of every cron tick. Each flush is ONE
// batched additive upsert per (hour, source) touched. The price is that an evicted
// isolate loses < FLUSH_INTERVAL_MS of tallies: the meter is approximate by design.

import { startOfHour, subDays } from 'date-fns';
import { UTCDate } from '@date-fns/utc';
import type { D1Like } from '../db/driver';
import { emptyCounts, type UsageCounts, type UsageMeter } from './meter';

export const FLUSH_INTERVAL_MS = 60_000;
export const USAGE_RETENTION_DAYS = 30;

/** key = `${bucket}\u0000${source}` */
let pending = new Map<string, UsageCounts>();
let lastFlushMs = 0;

export function hourBucket(ms: number): string {
  return startOfHour(new UTCDate(ms)).toISOString();
}

/** Merge one invocation's tallies into the isolate's pending buffer. */
export function accumulate(meter: UsageMeter, nowMs: number = Date.now()): void {
  const bucket = hourBucket(nowMs);
  for (const [source, c] of meter.entries()) {
    const key = `${bucket}\u0000${source}`;
    const acc = pending.get(key) ?? emptyCounts();
    acc.invocations += c.invocations;
    acc.queries += c.queries;
    acc.rowsRead += c.rowsRead;
    acc.rowsWritten += c.rowsWritten;
    pending.set(key, acc);
  }
}

/**
 * Write the buffer if it's been FLUSH_INTERVAL_MS since this isolate last did
 * (or `force`). The buffer is swapped out BEFORE the await so a concurrent
 * request accumulates into a fresh map; on failure the drained tallies are
 * dropped (never retried into a double count).
 */
export async function maybeFlush(
  db: D1Like,
  opts: { force?: boolean; prune?: boolean; nowMs?: number } = {},
): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!opts.force && nowMs - lastFlushMs < FLUSH_INTERVAL_MS) return;
  lastFlushMs = nowMs;
  const drained = pending;
  pending = new Map();
  if (drained.size === 0 && !opts.prune) return;

  const stmts = [...drained.entries()].map(([key, c]) => {
    const [bucket, source] = key.split('\u0000') as [string, string];
    return db
      .prepare(
        `INSERT INTO usage_stats (bucket, source, invocations, queries, rows_read, rows_written)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket, source) DO UPDATE SET
           invocations  = invocations  + excluded.invocations,
           queries      = queries      + excluded.queries,
           rows_read    = rows_read    + excluded.rows_read,
           rows_written = rows_written + excluded.rows_written`,
      )
      .bind(bucket, source, c.invocations, c.queries, c.rowsRead, c.rowsWritten);
  });
  if (opts.prune) {
    const cutoff = hourBucket(subDays(new UTCDate(nowMs), USAGE_RETENTION_DAYS).getTime());
    stmts.push(db.prepare(`DELETE FROM usage_stats WHERE bucket < ?`).bind(cutoff));
  }
  if (stmts.length > 0) await db.batch(stmts);
}

/** Test seam: reset module state between tests. */
export function resetUsageBuffer(): void {
  pending = new Map();
  lastFlushMs = 0;
}

// --- Reads (operator overview) -------------------------------------------------

export interface UsageRow {
  bucket: string;
  source: string;
  invocations: number;
  queries: number;
  rowsRead: number;
  rowsWritten: number;
}

export async function usageSince(db: D1Like, sinceBucket: string): Promise<UsageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT bucket, source, invocations, queries, rows_read, rows_written
       FROM usage_stats WHERE bucket >= ? ORDER BY bucket`,
    )
    .bind(sinceBucket)
    .all<{
      bucket: string;
      source: string;
      invocations: number;
      queries: number;
      rows_read: number;
      rows_written: number;
    }>();
  return results.map((r) => ({
    bucket: r.bucket,
    source: r.source,
    invocations: r.invocations,
    queries: r.queries,
    rowsRead: r.rows_read,
    rowsWritten: r.rows_written,
  }));
}

export async function earliestUsageBucket(db: D1Like): Promise<string | null> {
  const r = await db
    .prepare(`SELECT MIN(bucket) AS m FROM usage_stats`)
    .first<{ m: string | null }>();
  return r?.m ?? null;
}
