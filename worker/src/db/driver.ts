// Minimal structural subset of Cloudflare's D1Database we depend on. In
// production this is the real `env.DB` binding; tests back it with
// better-sqlite3 (see worker/test/support/sqlite-d1.ts). Keeping the DAO behind
// this interface is what lets the privacy-invariant tests run real SQL.

export interface D1Result<T> {
  results: T[];
}

/**
 * The subset of a run()'s result we read: the number of rows written. Real D1
 * exposes it under `meta.changes`; the better-sqlite3 test backing surfaces a
 * top-level `changes`. `runChanges` reads whichever is present.
 */
export interface D1RunResult {
  meta?: { changes?: number };
  changes?: number;
}

/** Rows affected by a run(), tolerant of D1 (`meta.changes`) vs sqlite (`changes`). */
export function runChanges(res: D1RunResult): number {
  return res.meta?.changes ?? res.changes ?? 0;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1RunResult>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
