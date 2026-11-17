// D1 usage meter. Wraps the D1 binding so every query's billing counters
// (meta.rows_read / meta.rows_written — what Cloudflare bills on) are tallied
// against a SOURCE label: the route ("GET /api/risk/boards/:id") or the cron job
// ("cron:poll"). Exists because the dashboard only shows a database-wide total,
// which can't say WHICH code path is doing the writing.
//
// Pure wrapper: no I/O of its own. Persistence (in-isolate accumulation + the
// throttled flush into usage_stats) lives in ./store.ts.

import type {
  D1Like,
  D1Meta,
  D1PreparedStatement,
  D1Result,
  D1RunResult,
} from '../db/driver';

export interface UsageCounts {
  invocations: number;
  queries: number;
  rowsRead: number;
  rowsWritten: number;
}

export function emptyCounts(): UsageCounts {
  return { invocations: 0, queries: 0, rowsRead: 0, rowsWritten: 0 };
}

/** Per-invocation tally. `source` is mutable so one cron tick can attribute each
 *  of its sequential jobs separately. Not safe to share across concurrent
 *  invocations — make one per fetch()/scheduled(). */
export class UsageMeter {
  private readonly tallies = new Map<string, UsageCounts>();

  constructor(public source: string) {
    this.at(source).invocations++;
  }

  /** Switch attribution (cron jobs). Counts the new source as invoked once. */
  setSource(source: string): void {
    this.source = source;
    this.at(source).invocations++;
  }

  record(meta: D1Meta | undefined, fallbackRead: number): void {
    const c = this.at(this.source);
    c.queries++;
    // Real D1 always reports both; the sqlite test backing reports neither, so
    // fall back to what we can observe (rows returned / rows changed).
    c.rowsRead += meta?.rows_read ?? fallbackRead;
    c.rowsWritten += meta?.rows_written ?? meta?.changes ?? 0;
  }

  entries(): Array<[string, UsageCounts]> {
    return [...this.tallies.entries()];
  }

  private at(source: string): UsageCounts {
    let c = this.tallies.get(source);
    if (!c) {
      c = emptyCounts();
      this.tallies.set(source, c);
    }
    return c;
  }
}

/** sqlite's run() result carries a top-level `changes` instead of `meta`. */
function runMeta(res: D1RunResult): D1Meta | undefined {
  if (res.meta) return res.meta;
  return res.changes !== undefined ? { changes: res.changes } : undefined;
}

class MeteredStatement implements D1PreparedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly meter: UsageMeter,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new MeteredStatement(this.inner.bind(...values), this.meter);
  }

  // first() is implemented over all() because D1's first() drops `meta`. Same
  // query, same rows read — D1 executes the full statement either way.
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const res = await this.inner.all<Record<string, unknown>>();
    this.meter.record(res.meta, res.results.length);
    const row = res.results[0];
    if (!row) return null;
    if (colName !== undefined) return (row[colName] ?? null) as T;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = await this.inner.all<T>();
    this.meter.record(res.meta, res.results.length);
    return res;
  }

  async run(): Promise<D1RunResult> {
    const res = await this.inner.run();
    this.meter.record(runMeta(res), 0);
    return res;
  }
}

function isRunResult(x: unknown): x is D1RunResult {
  return typeof x === 'object' && x !== null;
}

/** A D1Like that tallies every query into `meter`, delegating to `db`. */
export function meterD1(db: D1Like, meter: UsageMeter): D1Like {
  return {
    prepare(sql: string): D1PreparedStatement {
      return new MeteredStatement(db.prepare(sql), meter);
    },
    async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
      // The real binding only accepts its own statement objects — unwrap.
      const inner = statements.map((s) => (s instanceof MeteredStatement ? s.inner : s));
      const out = await db.batch(inner);
      for (const r of out) {
        if (isRunResult(r)) meter.record(runMeta(r), 0);
      }
      return out;
    },
  };
}

/**
 * Collapse a request path into a low-cardinality source label: ids (numeric,
 * uuid-ish, long opaque tokens, Jira `cloud:key:id` composites) become `:id`, so
 * "GET /api/risk/boards/12" and ".../34" share one row.
 */
export function routeLabel(method: string, path: string): string {
  const segs = path.split('/').map((s) => {
    if (s === '') return s;
    if (/^\d+$/.test(s)) return ':id';
    if (s.includes(':') || s.includes('%3A')) return ':id';
    if (/^[0-9a-f-]{16,}$/i.test(s)) return ':id';
    if (s.length > 24) return ':id';
    return s;
  });
  return `${method} ${segs.join('/')}`;
}
