import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { LocalDatabase } from "./db";

type Row = { id: string; namespace: string; metadata: string; embedding: Uint8Array };

export class SQLiteVectors {
  constructor(readonly db: LocalDatabase, readonly dimensions = 1536) {
    if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error("Invalid vector dimensions");
    db.sqlite.exec(`CREATE TABLE IF NOT EXISTS _runtime_vectors (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, metadata TEXT NOT NULL, embedding BLOB NOT NULL
    ); CREATE INDEX IF NOT EXISTS _runtime_vectors_namespace_id ON _runtime_vectors(namespace, id);`);
    db.sqlite.exec("CREATE TABLE IF NOT EXISTS _runtime_vector_config (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    db.sqlite.query("INSERT OR IGNORE INTO _runtime_vector_config VALUES ('dimensions', ?)").run(dimensions);
    const config = db.sqlite.query("SELECT value FROM _runtime_vector_config WHERE key = 'dimensions'").get() as { value: number };
    if (config.value !== dimensions) throw new Error("Stored vector dimensions do not match configuration");
  }

  private values(values: VectorizeVector["values"]) {
    if (values.length !== this.dimensions) throw new Error(`Expected ${this.dimensions} vector values`);
    let sum = 0;
    for (const v of values) {
      if (!Number.isFinite(v)) throw new Error("Vector values must be finite");
      sum += v * v;
    }
    if (!Number.isFinite(sum) || sum === 0) throw new Error("Vector must have a finite nonzero norm");
    return Float32Array.from(values, (v) => v / Math.sqrt(sum));
  }

  private decode(bytes: Uint8Array) {
    // SQLite blob byte offsets need not be aligned for Float32Array.
    return new Float32Array(Uint8Array.from(bytes).buffer);
  }

  async upsert(vectors: VectorizeVector[]) {
    this.db.sqlite.transaction(() => {
      const statement = this.db.sqlite.query("INSERT INTO _runtime_vectors VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET namespace=excluded.namespace, metadata=excluded.metadata, embedding=excluded.embedding");
      for (const vector of vectors) {
        if (!vector.namespace) throw new Error("Vector namespace is required");
        const values = this.values(vector.values);
        statement.run(vector.id, vector.namespace, JSON.stringify(vector.metadata ?? {}), new Uint8Array(values.buffer));
      }
    }).immediate();
    return { mutationId: randomUUID(), count: vectors.length, ids: vectors.map((v) => v.id) };
  }

  async query(vector: VectorizeVector["values"], options: VectorizeQueryOptions = {}) {
    if (!options.namespace) throw new Error("Vector query namespace is required");
    // Current application queries have no metadata filter; fail closed for unsupported filters.
    if (options.filter) throw new Error("Vector metadata filters are not supported");
    const topK = options.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new Error("topK must be between 1 and 100");
    const input = this.values(vector);
    const best: { row: Row; score: number }[] = [];
    // Keyset pages release their read cursor before yielding, allowing writes/checkpoints.
    // This is a best-effort view under concurrent writes, not a long-lived SQLite snapshot.
    const upper = this.db.sqlite.query("SELECT id FROM _runtime_vectors WHERE namespace = ? ORDER BY id DESC LIMIT 1").get(options.namespace) as { id: string } | null;
    let after: string | undefined;
    while (upper) {
      const statement = this.db.sqlite.prepare(`SELECT * FROM _runtime_vectors WHERE namespace = ? AND id <= ? ${after === undefined ? "" : "AND id > ?"} ORDER BY id LIMIT 256`);
      let scanned = 0;
      try {
        const bindings = after === undefined ? [options.namespace, upper.id] : [options.namespace, upper.id, after];
        for (const value of statement.iterate(...bindings)) {
          const row = value as Row;
          after = row.id;
          scanned++;
          const values = this.decode(row.embedding);
          let score = 0;
          for (let i = 0; i < input.length; i++) score += input[i] * values[i];
          score = Math.max(-1, Math.min(1, score));
          if (best.length === topK && score <= best[best.length - 1].score) continue;
          const at = best.findIndex((entry) => score > entry.score);
          best.splice(at < 0 ? best.length : at, 0, { row, score });
          if (best.length > topK) best.pop();
        }
      } finally { statement.finalize(); }
      if (scanned < 256 || after === upper.id) break;
      await yieldToEventLoop();
    }
    const matches = best.map(({ row, score }) => ({
      id: row.id, namespace: row.namespace, score,
      ...(options.returnValues ? { values: Array.from(this.decode(row.embedding)) } : {}),
      ...(options.returnMetadata && options.returnMetadata !== "none" ? { metadata: JSON.parse(row.metadata) } : {}),
    }));
    return { count: matches.length, matches };
  }

  async getByIds(ids: string[]) {
    const statement = this.db.sqlite.query("SELECT * FROM _runtime_vectors WHERE id = ?");
    return ids.flatMap((id) => {
      const row = statement.get(id) as Row | null;
      return row ? [{ id, namespace: row.namespace, values: Array.from(this.decode(row.embedding)), metadata: JSON.parse(row.metadata) }] : [];
    });
  }

  async deleteByIds(ids: string[]) {
    this.db.sqlite.transaction(() => {
      const statement = this.db.sqlite.query("DELETE FROM _runtime_vectors WHERE id = ?");
      for (const id of ids) statement.run(id);
    }).immediate();
    return { mutationId: randomUUID(), count: ids.length, ids };
  }
}

export function createVectors(db: LocalDatabase, dimensions = 1536): Vectorize & SQLiteVectors {
  return new SQLiteVectors(db, dimensions) as unknown as Vectorize & SQLiteVectors;
}
