import { Database } from "bun:sqlite";
import { SQLiteDatabase } from "./db";

type ReadType = "text" | "json" | "arrayBuffer" | "stream";
type Entry = { key: string; value: Uint8Array; expiration: number | null; metadata: string | null };

export class SQLiteKV {
  readonly sqlite: Database;
  constructor(db: SQLiteDatabase | Database) {
    this.sqlite = db instanceof SQLiteDatabase ? db.sqlite : db;
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS _runtime_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration INTEGER, metadata TEXT)");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS _runtime_kv_expiry ON _runtime_kv(expiration)");
  }

  async get(key: string, options?: ReadType | { type?: ReadType; cacheTtl?: number }) {
    return (await this.getWithMetadata(key, options)).value;
  }

  async getWithMetadata(key: string, options?: ReadType | { type?: ReadType; cacheTtl?: number }) {
    const entry = this.sqlite.query("SELECT * FROM _runtime_kv WHERE key = ? AND (expiration IS NULL OR expiration > ?)").get(key, Math.floor(Date.now() / 1000)) as Entry | null;
    if (!entry) return { value: null, metadata: null, cacheStatus: null };
    const type = typeof options === "string" ? options : options?.type;
    const bytes = new Uint8Array(entry.value);
    const text = () => new TextDecoder().decode(bytes);
    const value = type === "json" ? JSON.parse(text()) : type === "arrayBuffer" ? bytes.buffer :
      type === "stream" ? new Blob([bytes]).stream() : text();
    return { value, metadata: entry.metadata === null ? null : JSON.parse(entry.metadata), cacheStatus: null };
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: {
    expiration?: number; expirationTtl?: number; metadata?: unknown;
  }) {
    const expiration = options?.expirationTtl !== undefined ? Math.floor(Date.now() / 1000) + options.expirationTtl : options?.expiration ?? null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value) :
      ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(await new Response(value).arrayBuffer());
    this.sqlite.query("INSERT INTO _runtime_kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expiration=excluded.expiration, metadata=excluded.metadata")
      .run(key, bytes, expiration, options?.metadata === undefined ? null : JSON.stringify(options.metadata));
  }

  async delete(key: string) { this.sqlite.query("DELETE FROM _runtime_kv WHERE key = ?").run(key); }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    this.sqlite.query("DELETE FROM _runtime_kv WHERE expiration <= ?").run(Math.floor(Date.now() / 1000));
    const limit = Math.max(1, Math.min(1000, options.limit ?? 1000));
    const cursor = options.cursor ? Buffer.from(options.cursor, "base64url").toString() : "";
    const rows = this.sqlite.query("SELECT key, expiration, metadata FROM _runtime_kv WHERE substr(key, 1, length(?)) = ? AND key > ? ORDER BY key LIMIT ?")
      .all(options.prefix ?? "", options.prefix ?? "", cursor, limit + 1) as Entry[];
    const keys = rows.slice(0, limit).map((r) => ({ name: r.key, ...(r.expiration === null ? {} : { expiration: r.expiration }), ...(r.metadata === null ? {} : { metadata: JSON.parse(r.metadata) }) }));
    const complete = rows.length <= limit;
    return { keys, list_complete: complete, cursor: complete ? "" : Buffer.from(keys.at(-1)!.name).toString("base64url"), cacheStatus: null };
  }
}

export function createKV(db: SQLiteDatabase | Database): KVNamespace & SQLiteKV {
  return new SQLiteKV(db) as unknown as KVNamespace & SQLiteKV;
}
