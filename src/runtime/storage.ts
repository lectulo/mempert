import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { open, opendir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

type Body = string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null;
type Metadata = { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> };
type RecordEntry = { key: string; blob: string; size: number; etag: string; uploaded: number; metadata: string };
const WEEK = 7 * 86400_000;

/** Immutable blob files + an atomic SQLite catalog; object keys never become filesystem paths. */
export class FileStorage {
  readonly sqlite: Database;
  private readonly blobs: string;

  constructor(readonly root: string) {
    this.root = resolve(root);
    this.blobs = join(this.root, "blobs");
    mkdirSync(this.blobs, { recursive: true });
    this.sqlite = new Database(join(this.root, "catalog.sqlite"), { create: true });
    this.sqlite.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS _runtime_objects (key TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, uploaded INTEGER NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS _runtime_uploads (id TEXT PRIMARY KEY, key TEXT NOT NULL, metadata TEXT NOT NULL, touched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _runtime_parts (upload TEXT NOT NULL, number INTEGER NOT NULL, blob TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY(upload, number));
      CREATE INDEX IF NOT EXISTS _runtime_objects_blob ON _runtime_objects(blob);
      CREATE INDEX IF NOT EXISTS _runtime_parts_blob ON _runtime_parts(blob);
      CREATE INDEX IF NOT EXISTS _runtime_uploads_touched ON _runtime_uploads(touched);`);
  }

  private key(key: string) {
    if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0") || key.split("/").some((p) => p === ".." || p === ".")) {
      throw new TypeError("Invalid storage key");
    }
    return key;
  }

  private path(blob: string) {
    // Also validate identifiers read from the catalog before touching the filesystem.
    if (!/^[a-f0-9-]{36}$/.test(blob)) throw new Error("Invalid blob identifier");
    return join(this.blobs, blob);
  }

  private async write(value: Body) {
    const blob = randomUUID();
    const hash = createHash("md5");
    let size = 0;
    let source: ReadableStream<Uint8Array>;
    if (value instanceof ReadableStream) source = value;
    else if (value instanceof Blob) source = value.stream();
    else {
      const bytes = value === null ? Buffer.alloc(0) : typeof value === "string" ? Buffer.from(value) :
        value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      source = new Blob([bytes]).stream();
    }
    const reader = source.getReader();
    const file = await open(this.path(blob), "wx");
    try {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        hash.update(chunk); size += chunk.byteLength;
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          if (!bytesWritten) throw new Error("Storage write made no progress");
          offset += bytesWritten;
        }
      }
      await file.sync();
      return { blob, size, etag: hash.digest("hex") };
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      await this.removeBlob(blob);
      throw error;
    } finally {
      reader.releaseLock();
      await file.close();
    }
  }

  private async removeBlob(blob: string) {
    try { await unlink(this.path(blob)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private record(key: string) {
    return this.sqlite.query("SELECT * FROM _runtime_objects WHERE key = ?").get(this.key(key)) as RecordEntry | null;
  }

  private object(row: RecordEntry, range?: { offset: number; length: number }) {
    const meta = JSON.parse(row.metadata) as Metadata;
    if (meta.httpMetadata?.cacheExpiry) meta.httpMetadata.cacheExpiry = new Date(meta.httpMetadata.cacheExpiry);
    const object = {
      key: row.key, version: row.blob, size: row.size, etag: row.etag, httpEtag: `"${row.etag}"`,
      uploaded: new Date(row.uploaded), httpMetadata: meta.httpMetadata ?? {}, customMetadata: meta.customMetadata ?? {},
      checksums: {}, storageClass: "Standard" as const, ...(range ? { range } : {}),
      writeHttpMetadata(headers: Headers) {
        const names = { contentType: "content-type", contentLanguage: "content-language", contentDisposition: "content-disposition", contentEncoding: "content-encoding", cacheControl: "cache-control" };
        for (const [key, name] of Object.entries(names)) {
          const value = meta.httpMetadata?.[key as keyof R2HTTPMetadata];
          if (value !== undefined) headers.set(name, String(value));
        }
        if (meta.httpMetadata?.cacheExpiry) headers.set("expires", meta.httpMetadata.cacheExpiry.toUTCString());
      },
    };
    return object;
  }

  async head(key: string) {
    const row = this.record(key);
    return row ? this.object(row) : null;
  }

  async get(key: string, options?: { range?: R2Range | Headers; onlyIf?: R2Conditional | Headers }) {
    const row = this.record(key);
    if (!row) return null;
    if (options?.onlyIf) throw new Error("Conditional storage reads are not supported");
    let range: { offset: number; length: number } | undefined;
    if (options?.range) {
      let requested: R2Range;
      if (options.range instanceof Headers) {
        const header = options.range.get("range");
        const match = header?.match(/^bytes=(\d*)-(\d*)$/);
        if (!match || (!match[1] && !match[2])) throw new Error("Invalid byte range");
        requested = match[1] ? { offset: Number(match[1]), ...(match[2] ? { length: Number(match[2]) - Number(match[1]) + 1 } : {}) } : { suffix: Number(match[2]) };
      } else requested = options.range;
      const r = requested as { offset?: number; length?: number; suffix?: number };
      const offset = r.suffix !== undefined ? Math.max(0, row.size - r.suffix) : r.offset ?? 0;
      const length = Math.min(r.suffix ?? r.length ?? row.size - offset, row.size - offset);
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) throw new Error("Unsatisfiable byte range");
      range = { offset, length };
    }
    const file = Bun.file(this.path(row.blob));
    const body = (range ? file.slice(range.offset, range.offset + range.length) : file).stream();
    const response = new Response(body);
    return {
      ...this.object(row, range), body: response.body!,
      get bodyUsed() { return response.bodyUsed; },
      arrayBuffer: () => response.arrayBuffer(), text: () => response.text(), json: <T>() => response.json() as Promise<T>, blob: () => response.blob(),
    };
  }

  async put(key: string, value: Body, options: Metadata = {}) {
    this.key(key);
    const data = await this.write(value);
    const row: RecordEntry = { key, ...data, uploaded: Date.now(), metadata: JSON.stringify(options) };
    try {
      this.sqlite.query("INSERT INTO _runtime_objects (key, blob, size, etag, uploaded, metadata) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET blob=excluded.blob, size=excluded.size, etag=excluded.etag, uploaded=excluded.uploaded, metadata=excluded.metadata")
        .run(key, row.blob, row.size, row.etag, row.uploaded, row.metadata);
    } catch (error) { await this.removeBlob(data.blob); throw error; }
    return this.object(row);
  }

  async delete(keys: string | string[]) {
    const list = [keys].flat().map((k) => this.key(k));
    this.sqlite.transaction(() => { for (const key of list) this.sqlite.query("DELETE FROM _runtime_objects WHERE key = ?").run(key); }).immediate();
    // Old immutable blobs are collected later, so already-open readers remain valid.
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number; delimiter?: string; startAfter?: string; include?: string[] } = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
    const after = options.cursor ? Buffer.from(options.cursor, "base64url").toString() : options.startAfter ?? "";
    const prefix = options.prefix ?? "";
    const statement = this.sqlite.prepare("SELECT * FROM _runtime_objects WHERE substr(key, 1, length(?)) = ? AND key > ? ORDER BY key");
    const rows = statement.iterate(prefix, prefix, after);
    const objects: ReturnType<FileStorage["object"]>[] = [];
    const delimitedPrefixes = new Set<string>();
    let last = after;
    let truncated = false;
    try {
      for (const entry of rows) {
        const row = entry as RecordEntry;
        const at = options.delimiter ? row.key.indexOf(options.delimiter, prefix.length) : -1;
        const group = at >= 0 ? row.key.slice(0, at + options.delimiter!.length) : null;
        if (group && delimitedPrefixes.has(group)) { last = row.key; continue; }
        if (objects.length + delimitedPrefixes.size >= limit) { truncated = true; break; }
        if (group) delimitedPrefixes.add(group); else objects.push(this.object(row));
        last = row.key;
      }
    } finally { statement.finalize(); }
    return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated, ...(truncated ? { cursor: Buffer.from(last).toString("base64url") } : {}) };
  }

  async createMultipartUpload(key: string, options: Metadata = {}) {
    this.key(key);
    const id = randomUUID();
    this.sqlite.query("INSERT INTO _runtime_uploads VALUES (?, ?, ?, ?)").run(id, key, JSON.stringify(options), Date.now());
    return this.resumeMultipartUpload(key, id);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    this.key(key);
    const active = () => {
      const upload = this.sqlite.query("SELECT * FROM _runtime_uploads WHERE id = ? AND key = ?").get(uploadId, key) as { metadata: string } | null;
      if (!upload) throw new Error("Multipart upload does not exist");
      this.sqlite.query("UPDATE _runtime_uploads SET touched = ? WHERE id = ?").run(Date.now(), uploadId);
      return upload;
    };
    return {
      key, uploadId,
      uploadPart: async (partNumber: number, value: Body) => {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("Invalid multipart part number");
        active();
        const data = await this.write(value);
        try {
          this.sqlite.transaction(() => {
            active();
            this.sqlite.query("INSERT INTO _runtime_parts VALUES (?, ?, ?, ?, ?) ON CONFLICT(upload, number) DO UPDATE SET blob=excluded.blob, size=excluded.size, etag=excluded.etag")
              .run(uploadId, partNumber, data.blob, data.size, data.etag);
          }).immediate();
        } catch (error) { await this.removeBlob(data.blob); throw error; }
        return { partNumber, etag: data.etag };
      },
      abort: async () => {
        this.sqlite.transaction(() => {
          this.sqlite.query("DELETE FROM _runtime_uploads WHERE id = ? AND key = ?").run(uploadId, key);
          this.sqlite.query("DELETE FROM _runtime_parts WHERE upload = ? AND NOT EXISTS (SELECT 1 FROM _runtime_uploads WHERE id = ?)").run(uploadId, uploadId);
        }).immediate();
      },
      complete: async (parts: R2UploadedPart[]) => {
        const upload = active();
        if (!parts.length || parts.some((p, i) => i > 0 && p.partNumber <= parts[i - 1].partNumber)) throw new Error("Multipart parts must be nonempty and ordered");
        const records = parts.map((p) => {
          const row = this.sqlite.query("SELECT * FROM _runtime_parts WHERE upload = ? AND number = ?").get(uploadId, p.partNumber) as RecordEntry | null;
          if (!row || row.etag !== p.etag) throw new Error("Multipart part missing or etag mismatch");
          return row;
        });
        const self = this;
        const source = Readable.from((async function* () {
          for (const row of records) for await (const chunk of createReadStream(self.path(row.blob))) yield chunk;
        })());
        const data = await this.write(Readable.toWeb(source) as ReadableStream);
        const row = { key, ...data, uploaded: Date.now(), metadata: upload.metadata };
        try {
          this.sqlite.transaction(() => {
            active();
            // Detect concurrent part replacement while the assembled file was being streamed.
            for (let i = 0; i < parts.length; i++) {
              const current = this.sqlite.query("SELECT blob FROM _runtime_parts WHERE upload = ? AND number = ?").get(uploadId, parts[i].partNumber) as { blob: string } | null;
              if (current?.blob !== records[i].blob) throw new Error("Multipart parts changed during completion");
            }
            this.sqlite.query("INSERT INTO _runtime_objects VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET blob=excluded.blob, size=excluded.size, etag=excluded.etag, uploaded=excluded.uploaded, metadata=excluded.metadata")
              .run(key, row.blob, row.size, row.etag, row.uploaded, row.metadata);
            this.sqlite.query("DELETE FROM _runtime_parts WHERE upload = ?").run(uploadId);
            this.sqlite.query("DELETE FROM _runtime_uploads WHERE id = ?").run(uploadId);
          }).immediate();
        } catch (error) { await this.removeBlob(data.blob); throw error; }
        return this.object(row);
      },
    };
  }

  /** Await from runtime maintenance (including initial cleanup); no constructor background work. */
  async cleanup(now = Date.now()): Promise<void> {
    const cutoff = now - WEEK;
    // Bound each write statement, and never hold a transaction/cursor across a yield.
    const deletes = [
      "DELETE FROM _runtime_objects WHERE rowid IN (SELECT rowid FROM _runtime_objects WHERE key >= 'tmp/' AND key < 'tmp0' AND uploaded < ? LIMIT 256)",
      "DELETE FROM _runtime_parts WHERE rowid IN (SELECT p.rowid FROM _runtime_uploads u JOIN _runtime_parts p ON p.upload = u.id WHERE u.touched < ? LIMIT 256)",
      "DELETE FROM _runtime_uploads WHERE rowid IN (SELECT rowid FROM _runtime_uploads WHERE touched < ? AND NOT EXISTS (SELECT 1 FROM _runtime_parts WHERE upload = _runtime_uploads.id) LIMIT 256)",
    ];
    for (const sql of deletes) {
      while (this.sqlite.query(sql).run(cutoff).changes > 0) await yieldToEventLoop();
    }
    const directory = await opendir(this.blobs);
    let scanned = 0;
    for await (const entry of directory) {
      if (++scanned % 256 === 0) await yieldToEventLoop();
      const blob = entry.name;
      if (!entry.isFile() || !/^[a-f0-9-]{36}$/.test(blob)) continue;
      let modified: number;
      try { modified = (await stat(this.path(blob))).mtimeMs; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (modified >= cutoff) continue;
      const used = this.sqlite.query("SELECT 1 FROM _runtime_objects WHERE blob = ? UNION ALL SELECT 1 FROM _runtime_parts WHERE blob = ? LIMIT 1").get(blob, blob);
      // Blob IDs are immutable and never reused. Only old, unreferenced files are eligible.
      if (!used) await this.removeBlob(blob);
    }
  }

  close() { this.sqlite.close(); }
}

export function createStorage(root: string): R2Bucket & FileStorage {
  return new FileStorage(root) as unknown as R2Bucket & FileStorage;
}
