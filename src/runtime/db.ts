import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

class Statement {
  constructor(readonly database: SQLiteDatabase, readonly sql: string, readonly bindings: SQLQueryBindings[] = []) {}

  bind(...values: unknown[]) {
    return new Statement(this.database, this.sql, values.map((v) => {
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      if (Array.isArray(v)) return new Uint8Array(v);
      if (typeof v === "boolean") return Number(v);
      if (v === undefined) throw new TypeError("D1 bindings cannot be undefined");
      return v as SQLQueryBindings;
    }));
  }

  execute() {
    const start = performance.now();
    const db = this.database.sqlite;
    const before = db.query("SELECT total_changes() AS n").get() as { n: number };
    const stmt = db.query(this.sql);
    const results = stmt.all(...this.bindings);
    const state = db.query("SELECT changes() AS changes, last_insert_rowid() AS last_row_id, total_changes() AS n").get() as {
      changes: number; last_row_id: number; n: number;
    };
    // changes() retains the last write's count after SELECT; do not report it for reads.
    const written = state.n - before.n;
    return {
      success: true as const,
      results,
      meta: {
        duration: performance.now() - start, changes: written ? state.changes : 0,
        last_row_id: Number(state.last_row_id), changed_db: written > 0,
        size_after: Number((db.query("PRAGMA page_count").get() as { page_count: number }).page_count) *
          Number((db.query("PRAGMA page_size").get() as { page_size: number }).page_size),
        rows_read: results.length, rows_written: written,
      },
    };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.execute().results[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>() { return this.execute() as D1Result<T>; }
  async run<T = Record<string, unknown>>() { return this.execute() as D1Result<T>; }
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.database.sqlite.query(this.sql);
    const rows = stmt.values(...this.bindings);
    return (options?.columnNames ? [stmt.columnNames, ...rows] : rows) as T[];
  }
}

/** D1 compatibility layer. sqlite is deliberately public for durable queues and KV. */
export class SQLiteDatabase {
  readonly sqlite: Database;

  constructor(path: string, migrationsDir?: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path, { create: true });
    try {
      this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      if (migrationsDir) this.migrate(migrationsDir);
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  private migrate(dir: string) {
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS _runtime_migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
    for (const filename of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      this.sqlite.transaction(() => {
        if (this.sqlite.query("SELECT 1 FROM _runtime_migrations WHERE filename = ?").get(filename)) return;
        this.sqlite.exec(readFileSync(join(dir, filename), "utf8"));
        this.sqlite.query("INSERT INTO _runtime_migrations (filename) VALUES (?)").run(filename);
      }).immediate();
    }
  }

  prepare(sql: string): D1PreparedStatement { return new Statement(this, sql) as unknown as D1PreparedStatement; }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.sqlite.transaction(() => statements.map((statement) => {
      const s = statement as unknown as Statement;
      if (!(s instanceof Statement) || s.database !== this) throw new Error("Batch statement belongs to another database");
      return s.execute() as D1Result<T>;
    })).immediate();
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = performance.now();
    const before = (this.sqlite.query("SELECT total_changes() AS n").get() as { n: number }).n;
    this.sqlite.exec(sql);
    const after = (this.sqlite.query("SELECT total_changes() AS n").get() as { n: number }).n;
    return { count: after - before, duration: performance.now() - start };
  }

  close() { this.sqlite.close(); }
}

export function createDatabase(path: string, migrationsDir: string): D1Database & SQLiteDatabase {
  return new SQLiteDatabase(path, migrationsDir) as unknown as D1Database & SQLiteDatabase;
}

export { SQLiteDatabase as LocalDatabase };
