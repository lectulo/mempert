import { afterEach, beforeEach, expect, test, mock, spyOn } from "bun:test";
import { Api } from "grammy";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { LocalDatabase } from "./db";
import { createJobDispatcher } from "./jobs";
import { jobDatabase, flushJobContinuations } from "../job";
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

test("disabled ZIP uploads reject new links and all actions on stale signed links", async () => {
  const {db,env,sent}=fixture();
  db.sqlite.exec("INSERT INTO users(id,role) VALUES(1,'user')");
  const zip = await createZipImport(env, 1, "en");
  env.BATCH_ENABLED = "false";
  await expect(createZipImport(env, 1, "en")).rejects.toThrow("Batch imports are disabled");
  const ctx = {} as ExecutionContext;
  const page = await handleUpload(new Request(zip.url), env, ctx);
  expect(page.status).toBe(403);
  const html = await page.text();
  expect(html).toContain("Batch imports are disabled");
  expect(html).not.toContain('type="file"');
  for (const [action, method] of [["start", "POST"], ["part", "PUT"], ["complete", "POST"]]) {
    const url = new URL(zip.url);
    url.pathname += `/${action}`;
    const response = await handleUpload(new Request(url.toString(), { method, body: "{}" }), env, ctx);
    expect(response.status).toBe(403);
    expect(await response.json<{ error: string }>()).toEqual({ error: "batch_disabled" });
  }
  expect(db.sqlite.query("SELECT status,upload_id FROM zip_imports").all()).toEqual([{ status: "uploading", upload_id: null }]);
  expect(sent).toEqual([]);
});

test("disabled ZIP recovery stops saved photos and does not replay interrupted items", async () => {
  const {db,env,sent}=fixture();
  env.BATCH_ENABLED = "false";
  db.sqlite.exec(`INSERT INTO users(id,role) VALUES(1,'user');
    INSERT INTO zip_imports(id,user_id,import_id,status) VALUES('running',1,'batch1','running'),('old',1,'batch2','done');
    INSERT INTO memes(id,user_id,kind,file_id,file_unique_id,import_id) VALUES
      ('m1',1,'photo','','unique1','batch1'),('m2',1,'photo','','unique2','batch2');
    INSERT INTO zip_pending_items VALUES ('running','{"items":[]}');`);
  await recoverZipItems(env);
  await flushJobContinuations(env);
  expect(db.sqlite.query("SELECT status FROM zip_imports WHERE id='running'").get()).toEqual({ status: "failed" });
  expect(db.sqlite.query("SELECT status FROM memes ORDER BY id").all()).toEqual([{ status: "failed" }, { status: "failed" }]);
  expect(db.sqlite.query("SELECT count(*) AS n FROM zip_pending_items").get()).toEqual({ n: 0 });
  expect(db.sqlite.query("SELECT count(*) AS n FROM imports").get()).toEqual({ n: 0 });
  env.BATCH_ENABLED = "true";
  await recoverZipItems(env);
  await flushJobContinuations(env);
  expect(sent).toEqual([]);
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
