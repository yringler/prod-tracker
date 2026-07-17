// Test-only adapter: backs the D1Like interface with better-sqlite3 so the DAO's
// real SQL runs against a real engine. Production uses the genuine D1 binding.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  D1Like,
  D1PreparedStatement,
  D1Result,
  D1RunResult,
} from '../../src/db/driver';

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../../src/db/schema.sql', import.meta.url)),
  'utf8',
);

class Stmt implements D1PreparedStatement {
  private params: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as never[])) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (colName) return (row[colName] ?? null) as T;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...(this.params as never[])) as T[];
    return { results: rows };
  }

  async run(): Promise<D1RunResult> {
    return this.db.prepare(this.sql).run(...(this.params as never[]));
  }
}

export class SqliteD1 implements D1Like {
  private readonly db: Database.Database;
  constructor() {
    this.db = new Database(':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }
  prepare(sql: string): D1PreparedStatement {
    return new Stmt(this.db, sql);
  }
  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
  close(): void {
    this.db.close();
  }
}
