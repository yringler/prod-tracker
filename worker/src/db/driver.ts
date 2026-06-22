// Minimal structural subset of Cloudflare's D1Database we depend on. In
// production this is the real `env.DB` binding; tests back it with
// better-sqlite3 (see worker/test/support/sqlite-d1.ts). Keeping the DAO behind
// this interface is what lets the privacy-invariant tests run real SQL.

export interface D1Result<T> {
  results: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
