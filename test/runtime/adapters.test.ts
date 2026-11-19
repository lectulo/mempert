import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { join } from "node:path";
import { createDatabase, LocalDatabase } from "../../src/runtime/db";
import { createKV } from "../../src/runtime/kv";
import { createStorage } from "../../src/runtime/storage";
import { createVectors } from "../../src/runtime/vectors";

const base = join(import.meta.dir, "../../.runtime-test");
mkdirSync(base, { recursive: true });
const dirs: string[] = [];
const closers: (() => void)[] = [];
function temp() { const dir = mkdtempSync(join(base, "contract-")); dirs.push(dir); return dir; }
function database() { const db = new LocalDatabase(":memory:"); closers.push(() => db.close()); return db; }
afterEach(() => { for (const close of closers.splice(0)) close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

describe("SQLite D1", () => {
  test("all project migrations, duplicate numeric prefixes, FTS and restart", async () => {
    const path = join(temp(), "db.sqlite");
    const db = createDatabase(path, join(import.meta.dir, "../../migrations"));
    expect(db.sqlite.query("SELECT filename FROM _runtime_migrations WHERE filename LIKE '0018%'").all()).toHaveLength(2);
    await db.prepare("INSERT INTO users (id, role) VALUES (?, ?)").bind(1, "admin").run();
    await db.prepare("INSERT INTO memes (id,user_id,kind,file_id,file_unique_id,title) VALUES ('m',1,'photo','f','u','hello')").run();
    expect(await db.prepare("SELECT title FROM memes_fts WHERE memes_fts MATCH 'hello'").first<string>("title")).toBe("hello");
    db.close();
    const reopened = createDatabase(path, join(import.meta.dir, "../../migrations"));
    expect(await reopened.prepare("SELECT role FROM users WHERE id = 1").first<string>("role")).toBe("admin");
    reopened.close();
  });

  test("bindings, returning, metadata, raw and transactional rollback", async () => {
    const db = database();
    await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT UNIQUE)");
    const inserted = await db.prepare("INSERT INTO items(value) VALUES (?) RETURNING id").bind("one").all<{ id: number }>();
    expect(inserted.results[0].id).toBe(1);
    expect(inserted.meta.changes).toBe(1);
    expect(inserted.meta.last_row_id).toBe(1);
    expect((await db.prepare("SELECT * FROM items").all()).meta.changes).toBe(0);
    expect(await db.prepare("SELECT value FROM items WHERE id = ?1 OR id = ?1").bind(1).raw({ columnNames: true })).toEqual([["value"], ["one"]]);
    await expect(db.batch([db.prepare("INSERT INTO items(value) VALUES ('two')"), db.prepare("INSERT INTO items(value) VALUES ('one')")])).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) AS n FROM items").first<number>("n")).toBe(1);
    await expect(db.prepare("SELECT 1 AS n").first("absent")).rejects.toThrow();
  });

  test("failed migration is rolled back and not recorded", () => {
    const dir = temp();
    writeFileSync(join(dir, "0018_a.sql"), "CREATE TABLE a (id INTEGER);");
    writeFileSync(join(dir, "0018_b.sql"), "CREATE TABLE b (id INTEGER); INSERT INTO missing VALUES (1);");
    const path = join(temp(), "db.sqlite");
    expect(() => createDatabase(path, dir)).toThrow();
    writeFileSync(join(dir, "0018_b.sql"), "CREATE TABLE b (id INTEGER);");
    const db = createDatabase(path, dir);
    expect(db.sqlite.query("SELECT * FROM _runtime_migrations").all()).toHaveLength(2);
    db.close();
  });
});

test("KV OAuth JSON, metadata, binary, TTL and pagination", async () => {
  const db = database();
  const kv = createKV(db);
  await kv.put("grant:a", JSON.stringify({ scope: ["read"] }), { metadata: { owner: 1 } });
  expect(await kv.get<{scope:string[]}>("grant:a", "json")).toEqual({ scope: ["read"] });
  expect((await kv.getWithMetadata("grant:a", "json")).metadata).toEqual({ owner: 1 });
  await kv.put("grant:b", new Uint8Array([1, 2]));
  expect(new Uint8Array((await kv.get("grant:b", "arrayBuffer"))!)).toEqual(new Uint8Array([1, 2]));
  await kv.put("expired", "no", { expirationTtl: -1 });
  expect(await kv.get("expired")).toBeNull();
  const first = await kv.list({ prefix: "grant:", limit: 1 });
  expect(first.list_complete).toBe(false);
  expect((await kv.list({ prefix: "grant:", cursor: first.list_complete ? undefined : first.cursor })).keys.map((k) => k.name)).toEqual(["grant:b"]);
  await kv.delete("grant:a");
  expect(await kv.get("grant:a")).toBeNull();
});

describe("filesystem objects", () => {
  test("persistent metadata, ranges, pagination and safe opaque keys", async () => {
    const root = temp();
    let storage = createStorage(root);
    await storage.put("u/a", "abcdef", { httpMetadata: { contentType: "text/plain" }, customMetadata: { label: "ok" } });
    await storage.put("u/b", "second");
    storage.close();
    storage = createStorage(root);
    closers.push(() => storage.close());
    expect((await storage.head("u/a"))?.size).toBe(6);
    const object = await storage.get("u/a", { range: { offset: 1, length: 3 } });
    expect(await object!.text()).toBe("bcd");
    expect(object!.bodyUsed).toBe(true);
    expect(object!.customMetadata).toEqual({ label: "ok" });
    const headers = new Headers(); object!.writeHttpMetadata(headers);
    expect(headers.get("content-type")).toBe("text/plain");
    expect(await (await storage.get("u/a", { range: new Headers({ range: "bytes=-2" }) }))!.text()).toBe("ef");
    const first = await storage.list({ prefix: "u/", limit: 1 });
    expect(first.truncated).toBe(true);
    expect((await storage.list({ cursor: first.truncated ? first.cursor : undefined, prefix: "u/" })).objects[0].key).toBe("u/b");
    await expect(storage.put("../escape", "bad")).rejects.toThrow();
    await storage.delete(["u/a", "u/b"]);
    expect(await storage.get("u/a")).toBeNull();
  });

  test("streaming multipart resumes across restart and validates etags", async () => {
    const root = temp();
    let storage = createStorage(root);
    const upload = await storage.createMultipartUpload("archive.zip", { httpMetadata: { contentType: "application/zip" } });
    const part1 = await upload.uploadPart(1, new Blob(["first"]).stream());
    storage.close();
    storage = createStorage(root); closers.push(() => storage.close());
    const resumed = storage.resumeMultipartUpload(upload.key, upload.uploadId);
    const part2 = await resumed.uploadPart(2, "second");
    await expect(resumed.complete([{ partNumber: 1, etag: "wrong" }])).rejects.toThrow();
    await resumed.complete([part1, part2]);
    expect(await (await storage.get("archive.zip"))!.text()).toBe("firstsecond");
    await expect(resumed.uploadPart(3, "late")).rejects.toThrow();
  });

  test("failed writes preserve previous object; cleanup expires temporary files and abandoned uploads", async () => {
    const storage = createStorage(temp()); closers.push(() => storage.close());
    await storage.put("permanent", "old");
    await expect(storage.put("permanent", new ReadableStream({ start(c) { c.error(new Error("interrupted")); } }))).rejects.toThrow();
    expect(await (await storage.get("permanent"))!.text()).toBe("old");
    await storage.put("tmp/cache", "temporary");
    const upload = await storage.createMultipartUpload("abandoned");
    await upload.uploadPart(1, "part");
    await storage.cleanup(Date.now() + 8 * 86400_000);
    expect(await storage.head("tmp/cache")).toBeNull();
    expect(await storage.head("permanent")).not.toBeNull();
    await expect(upload.complete([{ partNumber: 1, etag: "anything" }])).rejects.toThrow();
  });

  test("async cleanup preserves old live blobs and active parts, collects expired and orphaned files repeatedly", async () => {
    const root = temp();
    const storage = createStorage(root); closers.push(() => storage.close());
    const now = Date.now();
    const old = new Date(now - 8 * 86400_000);
    const live = await storage.put("live", "keep");
    const expired = await storage.put("tmp/expired", "discard");
    const active = await storage.createMultipartUpload("active");
    const livePart = await active.uploadPart(1, "keep part");
    const abandoned = await storage.createMultipartUpload("abandoned");
    await abandoned.uploadPart(1, "discard part");
    const parts = storage.sqlite.query("SELECT upload, blob FROM _runtime_parts").all() as { upload: string; blob: string }[];
    const activeBlob = parts.find((p) => p.upload === active.uploadId)!.blob;
    const abandonedBlob = parts.find((p) => p.upload === abandoned.uploadId)!.blob;
    const orphan = randomUUID();
    writeFileSync(join(root, "blobs", orphan), "orphan");
    const freshOrphan = randomUUID();
    writeFileSync(join(root, "blobs", freshOrphan), "recent write, not yet published");
    if (!live || !expired) throw new Error("Expected stored objects");
    for (const blob of [live.version, expired.version, activeBlob, abandonedBlob, orphan]) utimesSync(join(root, "blobs", blob), old, old);
    storage.sqlite.query("UPDATE _runtime_objects SET uploaded = ? WHERE key = 'tmp/expired'").run(old.getTime());
    storage.sqlite.query("UPDATE _runtime_uploads SET touched = ? WHERE id = ?").run(old.getTime(), abandoned.uploadId);
    await storage.cleanup(now);
    await storage.cleanup(now);
    for (const blob of [live.version, activeBlob, freshOrphan]) expect(existsSync(join(root, "blobs", blob))).toBe(true);
    for (const blob of [expired.version, abandonedBlob, orphan]) expect(existsSync(join(root, "blobs", blob))).toBe(false);
    expect(await (await storage.get("live"))!.text()).toBe("keep");
    await active.complete([livePart]);
    expect(await (await storage.get("active"))!.text()).toBe("keep part");
    await expect(abandoned.uploadPart(2, "late")).rejects.toThrow();
    const plans = storage.sqlite.query("EXPLAIN QUERY PLAN SELECT 1 FROM _runtime_objects WHERE blob = ? UNION ALL SELECT 1 FROM _runtime_parts WHERE blob = ? LIMIT 1").all(live.version, live.version);
    expect(JSON.stringify(plans)).toContain("_runtime_objects_blob");
    expect(JSON.stringify(plans)).toContain("_runtime_parts_blob");
  });
});

test("local cosine vectors: namespaces, opaque IDs, bounded ranking, persistence and atomic upsert", async () => {
  const db = database();
  const vectors = createVectors(db, 3);
  await vectors.upsert([
    { id: "a:i", namespace: "u1", values: [5, 0, 0], metadata: { kind: "photo" } },
    { id: "b:t", namespace: "u1", values: [1, 1, 0] },
    { id: "secret", namespace: "u2", values: [1, 0, 0] },
  ]);
  const query = await vectors.query([1, 0, 0], { namespace: "u1", topK: 1, returnMetadata: "all" });
  expect(query.matches.map((m) => m.id)).toEqual(["a:i"]);
  expect(query.matches[0].score).toBeCloseTo(1);
  expect(query.matches[0].metadata).toEqual({ kind: "photo" });
  await expect(vectors.query([1, 0, 0])).rejects.toThrow("namespace");
  await expect(vectors.upsert([{ id: "new", namespace: "u1", values: [1, 0, 0] }, { id: "invalid", namespace: "u1", values: [0, 0, 0] }])).rejects.toThrow();
  expect(await vectors.getByIds(["new"])).toEqual([]);
  const reopened = createVectors(db, 3);
  expect((await reopened.getByIds(["a:i"]))[0].namespace).toBe("u1");
  expect(() => createVectors(db, 2)).toThrow();
  await vectors.deleteByIds(["a:i"]);
  expect((await vectors.query([1, 0, 0], { namespace: "u1" })).matches.map((m) => m.id)).toEqual(["b:t"]);
});

test("KV and vectors survive closing the shared database", async () => {
  const path = join(temp(), "shared.sqlite");
  let db = new LocalDatabase(path);
  await createKV(db).put("token", "persistent");
  await createVectors(db, 2).upsert([{ id: "opaque:🌍", namespace: "u1", values: [3, 4], metadata: { kind: "image" } }]);
  db.close();
  db = new LocalDatabase(path); closers.push(() => db.close());
  expect(await createKV(db).get("token")).toBe("persistent");
  const vectors = createVectors(db, 2);
  expect((await vectors.getByIds(["opaque:🌍"]))[0].metadata).toEqual({ kind: "image" });
  expect((await vectors.query([3, 4], { namespace: "u1" })).matches[0].score).toBeCloseTo(1);
});

test("vector keyset scan yields, permits concurrent writers and queries, and stays namespace bounded", async () => {
  const path = join(temp(), "vectors.sqlite");
  const db = new LocalDatabase(path); closers.push(() => db.close());
  const writer = new LocalDatabase(path); closers.push(() => writer.close());
  const vectors = createVectors(db, 2);
  const updates = createVectors(writer, 2);
  await vectors.upsert(Array.from({ length: 1024 }, (_, i) => ({ id: `v${String(i).padStart(4, "0")}`, namespace: "u1", values: [0, 1] })));
  await vectors.upsert([{ id: "foreign", namespace: "u2", values: [1, 0] }]);
  const pending = vectors.query([1, 0], { namespace: "u1", topK: 3 });
  const otherQuery = vectors.query([0, 1], { namespace: "u1", topK: 2 });
  let finished = false;
  void pending.then(() => { finished = true; });
  await yieldToEventLoop();
  expect(finished).toBe(false);
  await updates.deleteByIds(["v0400"]);
  await updates.upsert([{ id: "v0900", namespace: "u1", values: [1, 0] }, { id: "v0500-new", namespace: "u1", values: [1, 0] }]);
  const result = await pending;
  expect(result.matches).toHaveLength(3);
  expect(result.matches[0].score).toBeCloseTo(1);
  expect(result.matches.some((m) => m.id === "v0900")).toBe(true);
  expect(result.matches.every((m) => m.namespace === "u1")).toBe(true);
  expect(new Set(result.matches.map((m) => m.id)).size).toBe(3);
  expect((await otherQuery).matches).toHaveLength(2);
  expect((await vectors.query([1, 0], { namespace: "u1", topK: 3 })).matches[0].score).toBeCloseTo(1);
});
