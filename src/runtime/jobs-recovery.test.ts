import { afterEach, beforeEach, expect, test, mock, spyOn } from "bun:test";
import { Api } from "grammy";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { LocalDatabase } from "./db";
import { createJobDispatcher } from "./jobs";
import { jobDatabase, flushJobContinuations } from "../job";
import { EMBED_DIMS } from "../config";
import { sign } from "../media";
import type { Env } from "../env";

// Business modules transitively import the legacy edge entrypoint through widget helpers.
mock.module("../index", () => ({ default: {} }));
mock.module("@cloudflare/workers-oauth-provider", () => ({ AuthorizationError: class extends Error {}, getOAuthApi: () => ({}), default: class {} }));
const { createZipImport, recoverZipItems, handleUpload, handleZipCallback } = await import("../zip");

const open: LocalDatabase[] = [];
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let telegram: ReturnType<typeof spyOn<Api, "sendMessage">>;
let unexpected: string[];
let notices: string[];
beforeEach(() => {
  unexpected = []; notices = [];
  // grammY's Node transport captures node-fetch at import time. Stub this API
  // method, not the module, so other suites retain their original transport.
  telegram = spyOn(Api.prototype, "sendMessage").mockImplementation(async (_chat, text) => {
    notices.push(text);
    return { message_id: 1 } as never;
  });
  network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    unexpected.push(input instanceof Request ? input.url : String(input));
    throw new Error(`Recovery tests forbid outbound fetch: ${input}`);
  }, { preconnect: fetch.preconnect }));
});
afterEach(async () => {
  try {
    // notifyJob intentionally runs after durable completion. Keep its local
    // transport and database alive until those notification microtasks settle.
    await setImmediate();
    expect(unexpected).toEqual([]); // Detects even swallowed network errors.
  } finally {
    network.mockRestore(); telegram.mockRestore();
    for (const db of open.splice(0)) db.close();
  }
});
function fixture() {
  const db = new LocalDatabase(":memory:", join(import.meta.dir, "../../migrations")); open.push(db);
  const sent: unknown[] = [];
  const env = { DB: db, PUBLIC_URL:"http://app", INTERNAL_URL:"http://app", WORKER_SECRET:"secret", ENCRYPTION_KEY:"key", BOT_TOKEN:"1:fixture",
    JOBS: {send:async(body:unknown) => {sent.push(body);}},
    MEDIA:{delete:async()=>{}}, LIVE:{idFromName:(s:string)=>s,get:()=>({push:async()=>{}})},
  } as unknown as Env;
  jobDatabase(env);
  return {db,env,sent};
}
test("startup reconciles durable business done and orphan running rows", async () => {
  const {db,env}=fixture();
  db.sqlite.exec("INSERT INTO users(id) VALUES(1); INSERT INTO exports(id,user_id,status) VALUES('finished',1,'done'); INSERT INTO exports(id,user_id,status,updated_at) VALUES('orphan',1,'running',0)");
  const failures:string[]=[];
  const d=createJobDispatcher(db,env,{fail:async(_kind,id)=>{failures.push(id);db.sqlite.query("UPDATE exports SET status='failed' WHERE id=?").run(id);}});
  await d.EXPORT.get("finished").run("finished",{API_URL:"http://app/export/finished",TOKEN:"t"});
  await d.sweep();
  expect(db.sqlite.query("SELECT state FROM worker_jobs WHERE name='finished'").get()).toEqual({state:"done"});
  expect(failures).toEqual(["orphan"]);
});
test("ZIP insert-before-enqueue crash replays payload despite hash deduplication", async () => {
  const {db,env,sent}=fixture();
  const hash="a".repeat(64);
  db.sqlite.exec("INSERT INTO users(id,role) VALUES(1,'admin'); INSERT INTO zip_imports(id,user_id,import_id,status) VALUES('z',1,'batch','running')");
  const payload={items:[{sha256:hash,kind:"photo",mime:"image/jpeg"}]};
  db.sqlite.query("INSERT INTO zip_pending_items VALUES('z',?)").run(JSON.stringify(payload));
  // This is the exact durable boundary: insertMeme committed, continuation not yet written.
  db.sqlite.query("INSERT INTO memes(id,user_id,kind,file_id,file_unique_id,sha256,added_via,import_id) VALUES('m',1,'photo','','r2:'||?,?,'zip','batch')").run(hash,hash);
  await recoverZipItems(env);
  expect(db.sqlite.query("SELECT count(*) AS n FROM zip_pending_items").get()).toEqual({n:0});
  await flushJobContinuations(env);
  expect(sent).toEqual([{type:"embed",memeId:"m"}]);
  expect(db.sqlite.query("SELECT imported FROM zip_imports WHERE id='z'").get()).toEqual({imported:1});
  // Replayed /items after another crash must neither overcount nor enqueue a second job.
  db.sqlite.query("INSERT INTO zip_pending_items VALUES('z',?)").run(JSON.stringify(payload));
  await recoverZipItems(env); await flushJobContinuations(env);
  expect(sent).toHaveLength(1);
  expect(db.sqlite.query("SELECT imported FROM zip_imports WHERE id='z'").get()).toEqual({imported:1});
});
test("ZIP done persists batch continuation before terminal status and cleanup", async () => {
  const {db,env,sent}=fixture();
  db.sqlite.exec("INSERT INTO users(id,role) VALUES(1,'admin'); INSERT INTO zip_imports(id,user_id,import_id,status) VALUES('z',1,'batch','running'); INSERT INTO memes(id,user_id,kind,file_id,file_unique_id,import_id) VALUES('m',1,'photo','','unique','batch')");
  const res=await handleZipCallback(new Request("http://app/zip/z/done",{method:"POST",headers:{Authorization:`Bearer ${await sign(env,"zip|z")}`},body:"{}"}),env);
  expect(res.status).toBe(200);
  expect(db.sqlite.query("SELECT status FROM zip_imports WHERE id='z'").get()).toEqual({status:"done"});
  expect(db.sqlite.query("SELECT count(*) AS n FROM worker_continuations").get()).toEqual({n:1});
  await recoverZipItems(env); await flushJobContinuations(env);
  expect(sent).toEqual([{type:"batch_submit",importId:"batch"}]);
});

test("ZIP uploads can start and finish using signed links issued before or after disabling Batch", async () => {
  const {db,env,sent}=fixture();
  db.sqlite.exec("INSERT INTO users(id,role) VALUES(1,'user')");
  const older = await createZipImport(env, 1, "en");
  env.BATCH_ENABLED = "false";
  const zip = await createZipImport(env, 1, "en");
  expect(zip.text).toContain("standard rates");
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  const completed: R2UploadedPart[][] = [];
  const upload = {
    uploadId: "upload",
    uploadPart: async (partNumber: number) => ({ partNumber, etag: "etag" }),
    complete: async (parts: R2UploadedPart[]) => completed.push(parts),
  };
  env.MEDIA = { ...env.MEDIA, createMultipartUpload: async () => upload, resumeMultipartUpload: () => upload } as unknown as Env["MEDIA"];
  const dispatcher = createJobDispatcher(db, env);
  env.ZIP = dispatcher.ZIP;
  const action = (action: string, method: string, body?: string) => {
    const url = new URL(older.url);
    url.pathname += `/${action}`;
    url.searchParams.set("n", "1");
    return handleUpload(new Request(url.toString(), { method, body }), env, ctx);
  };
  for (const link of [older.url, zip.url]) {
    const page = await handleUpload(new Request(link), env, ctx);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('type="file"');
    const bad = new URL(link);
    bad.searchParams.set("s", "invalid");
    expect((await handleUpload(new Request(bad.toString()), env, ctx)).status).toBe(403);
  }
  expect((await action("start", "POST")).status).toBe(200);
  const part = await action("part", "PUT", "part body");
  expect(part.status).toBe(200);
  expect((await action("complete", "POST", JSON.stringify({ parts: [await part.json()] }))).status).toBe(200);
  await Promise.all(tasks);
  expect(completed).toEqual([[{ partNumber: 1, etag: "etag" }]]);
  expect(db.sqlite.query("SELECT state FROM worker_jobs WHERE kind = 'zip' AND name = ?").get(older.id)).toEqual({ state: "queued" });
  expect(db.sqlite.query("SELECT status,upload_id FROM zip_imports WHERE id = ?").get(older.id)).toEqual({ status: "running", upload_id: "upload" });
  const workerAuth = { Authorization: `Bearer ${env.WORKER_SECRET}` };
  const claim = await dispatcher.handle(new Request("http://app/internal/jobs/zip/claim", { method: "POST", headers: workerAuth }));
  expect(claim?.status).toBe(200);
  const lease = await claim!.json<{ lease: string; env: { API_URL: string } }>();
  const done = await dispatcher.handle(new Request(`${lease.env.API_URL}/done`, {
    method: "POST", headers: { ...workerAuth, "X-Job-Lease": lease.lease }, body: "{}",
  }));
  expect(done?.status).toBe(200);
  expect(db.sqlite.query("SELECT state FROM worker_jobs WHERE kind = 'zip' AND name = ?").get(older.id)).toEqual({ state: "done" });
  expect(sent).toEqual([]);
});

test("disabled ZIP recovery replays interrupted items and stops only legacy staged batch photos", async () => {
  const {db,env,sent}=fixture();
  env.BATCH_ENABLED = "false";
  const hash = "a".repeat(64);
  db.sqlite.exec(`INSERT INTO users(id,role) VALUES(1,'user');
    INSERT INTO zip_imports(id,user_id,import_id,status) VALUES('running',1,'batch1','running'),('old',1,'batch2','done');
    INSERT INTO memes(id,user_id,kind,file_id,file_unique_id,import_id) VALUES
      ('m1',1,'photo','','unique1','batch1'),('m2',1,'photo','','unique2','batch2');`);
  db.sqlite.query("INSERT INTO zip_pending_items VALUES('running',?)").run(JSON.stringify({ items: [{ sha256: hash, kind: "photo" }] }));
  db.sqlite.query("INSERT INTO memes(id,user_id,kind,file_id,file_unique_id,sha256,added_via) VALUES('m3',1,'photo','','r2:'||?,?,'zip')").run(hash, hash);
  await recoverZipItems(env);
  await flushJobContinuations(env);
  expect(db.sqlite.query("SELECT status,imported FROM zip_imports WHERE id='running'").get()).toEqual({ status: "running", imported: 1 });
  expect(db.sqlite.query("SELECT status FROM memes ORDER BY id").all()).toEqual([{ status: "embedding" }, { status: "failed" }, { status: "embedding" }]);
  expect(db.sqlite.query("SELECT count(*) AS n FROM zip_pending_items").get()).toEqual({ n: 0 });
  expect(db.sqlite.query("SELECT count(*) AS n FROM imports").get()).toEqual({ n: 0 });
  const response = await handleZipCallback(new Request("http://app/zip/running/done", { method: "POST", headers: { Authorization: `Bearer ${await sign(env, "zip|running")}` }, body: "{}" }), env);
  expect(response.status).toBe(200);
  expect(db.sqlite.query("SELECT status FROM zip_imports WHERE id='running'").get()).toEqual({ status: "done" });
  expect(db.sqlite.query("SELECT status FROM memes WHERE id='m1'").get()).toEqual({ status: "failed" });
  env.BATCH_ENABLED = "true";
  await recoverZipItems(env);
  await flushJobContinuations(env);
  expect(sent).toEqual([{ type: "embed", memeId: "m3" }]);
});

test("disabled ZIP processing restores descriptions and existing vectors without re-description", async () => {
  const {db,env,sent}=fixture();
  env.BATCH_ENABLED = "false";
  const vectors: VectorizeVector[] = [];
  env.VECTORS = { upsert: async (batch: VectorizeVector[]) => { vectors.push(...batch); } } as unknown as Env["VECTORS"];
  db.sqlite.exec("INSERT INTO users(id,role) VALUES(1,'user'); INSERT INTO zip_imports(id,user_id,import_id,status) VALUES('z',1,'batch','running')");
  const items = [
    { sha256: "a".repeat(64), kind: "photo", restore: { title: "Saved title", description: "Saved description", text: Array(EMBED_DIMS).fill(0.1), created_at: 42 } },
    { sha256: "b".repeat(64), kind: "photo", restore: { title: "Saved without vector", description: "Also preserved" } },
    { sha256: "c".repeat(64), kind: "animation" },
    { sha256: "d".repeat(64), kind: "photo", links: ["https://e621.net/posts/7"] },
  ];
  const callback = async (action: string, body: unknown) => handleZipCallback(new Request(`http://app/zip/z/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${await sign(env, "zip|z")}` }, body: JSON.stringify(body),
  }), env);
  const filter = await callback("filter", { hashes: items.map((i) => i.sha256), formats: ["memesave", "files"] });
  expect(await filter.json<{ new: string[] }>()).toEqual({ new: items.map((i) => i.sha256) });
  expect((await callback("items", { items })).status).toBe(200);
  expect((await callback("done", {})).status).toBe(200);
  const rows = await env.DB.prepare("SELECT id,kind,title,description,status,import_id,created_at FROM memes ORDER BY sha256").all<{ id: string }>();
  const [restored, noVector, animation, linked] = rows.results;
  expect(restored).toMatchObject({ kind: "photo", title: "Saved title", description: "Saved description", status: "ready", import_id: null, created_at: 42 });
  expect(noVector).toMatchObject({ kind: "photo", title: "Saved without vector", description: "Also preserved", status: "describing", import_id: null });
  expect(animation).toMatchObject({ kind: "animation", status: "embedding", import_id: null });
  expect(linked).toMatchObject({ kind: "photo", status: "embedding", import_id: null });
  expect(vectors).toMatchObject([{ id: `${restored.id}:t`, namespace: "u1" }]);
  await flushJobContinuations(env);
  expect(sent).toEqual([{ type: "finish", memeId: noVector.id }, { type: "embed", memeId: animation.id }, { type: "source_meta", memeId: linked.id }]);
  expect(db.sqlite.query("SELECT status,imported,format FROM zip_imports WHERE id='z'").get()).toEqual({ status: "done", imported: 4, format: "memesave,files" });
  expect(db.sqlite.query("SELECT count(*) AS n FROM imports").get()).toEqual({ n: 0 });
});

test("ZIP recovery queues only the missing text vector after committing a restored description", async () => {
  const {db,env,sent}=fixture();
  env.BATCH_ENABLED = "false";
  const hash = "a".repeat(64);
  db.sqlite.exec("INSERT INTO users(id,role) VALUES(1,'user'); INSERT INTO zip_imports(id,user_id,import_id,status) VALUES('z',1,'batch','running')");
  db.sqlite.query("INSERT INTO zip_pending_items VALUES('z',?)").run(JSON.stringify({ items: [{ sha256: hash, kind: "photo", restore: { title: "Saved" } }] }));
  db.sqlite.query(`INSERT INTO memes(id,user_id,kind,file_id,file_unique_id,sha256,added_via,status,title)
    VALUES('m',1,'photo','','r2:'||?,?,'zip','describing','Saved')`).run(hash, hash);
  await recoverZipItems(env);
  await flushJobContinuations(env);
  expect(sent).toEqual([{ type: "finish", memeId: "m" }]);
  expect(db.sqlite.query("SELECT imported FROM zip_imports WHERE id = 'z'").get()).toEqual({ imported: 1 });
});
test("export media callback streams a local object without reading arrayBuffer", async () => {
  const {db,env}=fixture();
  db.sqlite.exec("INSERT INTO users(id) VALUES(1); INSERT INTO exports(id,user_id,status) VALUES('e',1,'running'); INSERT INTO memes(id,user_id,kind,file_id,file_unique_id,r2_file,mime) VALUES('m',1,'photo','','u','local.jpg','image/jpeg')");
  let buffered=false;
  env.MEDIA={head:async()=>({size:8,httpMetadata:{contentType:"image/jpeg"}}),get:async()=>({body:new Blob(["streamed"]).stream(),size:8,httpMetadata:{contentType:"image/jpeg"},arrayBuffer:async()=>{buffered=true;throw new Error("must stream");}})} as unknown as Env["MEDIA"];
  const {handleExport}=await import("../export");
  const response=await handleExport(new Request("http://app/export/e/media/m/file",{headers:{Authorization:`Bearer ${await sign(env,"export|e")}`}}),env);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("streamed");
  expect(buffered).toBe(false);
});
test("ZIP failure notification uses only the local grammY stub", async () => {
  const {db,env}=fixture();
  db.sqlite.exec("INSERT INTO users(id,role) VALUES(1,'admin'); INSERT INTO zip_imports(id,user_id,import_id,status) VALUES('z',1,'batch','running')");
  const {failZip}=await import("../zip");
  await failZip(env,"z","fixture failure");
  await setImmediate();
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("fixture failure");
});
