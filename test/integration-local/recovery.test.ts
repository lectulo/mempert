import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { fixture, vector } from "./fixture";
import type { Env } from "../../src/env";
import { Api } from "grammy";
const { pollImports, recoverBatchImports } = await import("../../src/batch");
const { hybridSearch } = await import("../../src/search/hybrid");
const { queueUploads, uploadJob } = await import("../../src/search/tgupload");

let f: Awaited<ReturnType<typeof fixture>>;
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let unexpected: string[];
let telegram: ReturnType<typeof spyOn>;
let notices: string[];
const oldSelfHosted = process.env.SELF_HOSTED;
beforeEach(async () => {
  f = await fixture(); unexpected = []; notices = [];
  // grammy captures its fetch when imported; intercept the API method rather
  // than allowing its captured transport to escape the global fetch guard.
  telegram = spyOn(Api.prototype, "sendMessage").mockImplementation(async (_chat, text) => {
    notices.push(text); return { message_id: 1 } as never;
  });
  process.env.SELF_HOSTED = "true";
  Object.assign(f.env, { OPENROUTER_API_KEY: "test-key" });
  network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    unexpected.push(String(input)); throw new Error(`Unexpected external call: ${input}`);
  }, {preconnect:fetch.preconnect}));
});
afterEach(() => {
  network.mockRestore(); telegram.mockRestore(); f.close(); expect(unexpected).toEqual([]);
  if (oldSelfHosted === undefined) delete process.env.SELF_HOSTED;
  else process.env.SELF_HOSTED = oldSelfHosted;
});

test("foreign vector IDs are rejected by SQL even when index violates namespace", async () => {
  await f.meme("own", 101); await f.meme("foreign", 202);
  const env = { ...f.env, VECTORS: { query: async () => ({ matches: [
    { id: "foreign:i", score: 1 }, { id: "own:t", score: 0.8 },
  ] }) } } as unknown as Env;
  expect((await hybridSearch(env, 101, { vectors: [vector()], texts: [], limit: 1 })).map(m => m.id)).toEqual(["own"]);
});

async function submitted() {
  await f.meme("photo", 101);
  await f.env.DB.prepare("INSERT INTO imports(id,user_id,status,batch_id,key_source,attempts,model) VALUES ('imp',101,'submitted','remote-1','global',1,'test-model')").run();
  await f.env.DB.prepare("UPDATE memes SET title=NULL,status='describing',import_id='imp' WHERE id='photo'").run();
}
function provider() {
  const methods: string[] = [];
  network.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === "https://openrouter.ai/api/v1/batches/remote-1") {
      methods.push("poll");
      return Response.json({ id: "remote-1", status: "completed", usage: { cost: 0.125, prompt_tokens: 20 }, results: [{
        custom_id: "photo", response: { body: { choices: [{ message: { content: JSON.stringify({
          title: "Recovered otter", description: "An otter", tags: ["otter"], search_phrases: ["otter"]
        }) } }] } }
      }] });
    }
    if (url === "https://api.telegram.org/bot1:test/sendMessage") {
      methods.push("notice"); return Response.json({ ok: true, result: { message_id: 1 } });
    }
    unexpected.push(url); throw new Error(`Unexpected external call: ${url}`);
  }, {preconnect:fetch.preconnect}));
  return methods;
}

test("crash after persisted description/accounting before enqueue recovers without double spend", async () => {
  await submitted(); provider();
  const failureEnv = { ...f.env, JOBS: {
    send: async () => { throw new Error("simulated queue unavailable after commit"); },
  } } as unknown as Env;
  await pollImports(failureEnv); // catches the injected enqueue failure, retains durable intents
  expect(await f.env.DB.prepare("SELECT title FROM memes WHERE id='photo'").first<string>("title")).toBe("Recovered otter");
  expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM batch_continuations").first<number>("n")).toBe(1);
  expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<number>("n")).toBe(1);
  // Reproduce a hard kill after the processing claim, not the catch-path reset.
  await f.env.DB.prepare("UPDATE imports SET status='processing' WHERE id='imp'").run();
  await f.reopen();
  await recoverBatchImports(f.env);
  await pollImports(f.env);
  await recoverBatchImports(f.env);
  expect(f.jobs).toContainEqual({ type: "finish", memeId: "photo", gen: 0 });
  expect(await f.env.DB.prepare("SELECT status FROM imports WHERE id='imp'").first<string>("status")).toBe("done");
  expect(await f.env.DB.prepare("SELECT described FROM imports WHERE id='imp'").first<number>("described")).toBe(1);
  expect(await f.env.DB.prepare("SELECT cost FROM imports WHERE id='imp'").first<number>("cost")).toBe(0.125);
  expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<number>("n")).toBe(1);
  expect(await f.env.DB.prepare("SELECT total_cost FROM users WHERE id=101").first<number>("total_cost")).toBe(0.125);
});

test("startup fails ambiguous external submit visibly without resubmitting AI", async () => {
  await submitted(); const calls = provider();
  await f.env.DB.prepare("UPDATE imports SET status='submitting',batch_id=NULL,submission_started=1 WHERE id='imp'").run();
  await f.reopen(); await recoverBatchImports(f.env);
  expect(await f.env.DB.prepare("SELECT status FROM imports WHERE id='imp'").first<string>("status")).toBe("failed");
  expect(await f.env.DB.prepare("SELECT status FROM memes WHERE id='photo'").first<string>("status")).toBe("failed");
  expect(await f.env.DB.prepare("SELECT error FROM imports WHERE id='imp'").first<string>("error")).toContain("external outcome unknown");
  expect(calls).toEqual([]);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("external outcome unknown");
  expect(f.jobs).toEqual([]);
});

test("startup completes while best-effort Telegram failure notice is still pending", async () => {
  await submitted();
  await f.env.DB.prepare("UPDATE imports SET status='submitting',batch_id=NULL,submission_started=1 WHERE id='imp'").run();
  let resolveNotice!: (value: never) => void;
  let noticeStarted = false;
  telegram.mockImplementation(() => {
    noticeStarted = true;
    return new Promise(resolve => { resolveNotice = resolve; });
  });
  let recoveryCompleted = false;
  const recovery = recoverBatchImports(f.env).then(() => { recoveryCompleted = true; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Yield without resolving the network promise. Recovery only uses local
    // SQLite/queue bindings and must finish independently of this notice.
    await Promise.race([recovery, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
    expect(noticeStarted).toBe(true);
    expect(recoveryCompleted).toBe(true);
  expect(await f.env.DB.prepare("SELECT status FROM imports WHERE id='imp'").first<string>("status")).toBe("failed");
    expect(await f.env.DB.prepare("SELECT error FROM imports WHERE id='imp'").first<string>("error")).toContain("external outcome unknown");
  } finally {
    clearTimeout(timer);
    resolveNotice?.({ message_id: 1 } as never);
    await recovery;
  }
});

test("description commit before spend receipt is recoverable and counted once", async () => {
  await submitted(); provider();
  let interrupted = false;
  const db = new Proxy(f.env.DB, { get(target, prop) {
    if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
      // Description transaction has three statements; the accounting transaction
      // has four. Fail before accounting commits, after description persisted.
      if (statements.length === 4 && !interrupted) { interrupted = true; throw new Error("crash before accounting"); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await pollImports({ ...f.env, DB: db });
  expect(interrupted).toBe(true);
  expect(await f.env.DB.prepare("SELECT described FROM imports WHERE id='imp'").first<number>("described")).toBe(1);
  expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<number>("n")).toBe(0);
  await f.reopen(); await recoverBatchImports(f.env); await pollImports(f.env);
  expect(await f.env.DB.prepare("SELECT described FROM imports WHERE id='imp'").first<number>("described")).toBe(1);
  expect(await f.env.DB.prepare("SELECT total_cost FROM users WHERE id=101").first<number>("total_cost")).toBe(0.125);
  expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<number>("n")).toBe(1);
});

test("finishDescribed detaches only with durable intent; failed enqueue survives another startup", async () => {
  await submitted();
  await f.env.DB.prepare("UPDATE memes SET title='Already described' WHERE id='photo'").run();
  await f.env.DB.prepare("UPDATE imports SET status='done' WHERE id='imp'").run();
  const env = { ...f.env, JOBS: { send: async () => { throw new Error("enqueue failed"); } } } as unknown as Env;
  await expect(recoverBatchImports(env)).rejects.toThrow("enqueue failed");
  expect(await f.env.DB.prepare("SELECT import_id FROM memes WHERE id='photo'").first("import_id")).toBeNull();
  expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM batch_continuations").first<number>("n")).toBe(1);
  await f.reopen(); await recoverBatchImports(f.env);
  expect(f.jobs).toEqual([{ type: "finish", memeId: "photo", gen: 0 }]);
  expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM batch_continuations").first<number>("n")).toBe(0);
});

test("no storage destination burns no attempts; personal destination and fair paced single-file jobs", async () => {
  for (const id of ["a1","a2","a3"]) await f.meme(id, 101);
  for (const id of ["b1","b2"]) await f.meme(id, 202);
  await queueUploads(f.env);
  expect(f.jobs).toEqual([]);
  expect(await f.env.DB.prepare("SELECT SUM(upload_tries) AS n FROM memes").first<number>("n")).toBe(0);
  await f.env.DB.prepare("INSERT INTO channels(chat_id,user_id,storage) VALUES (-1001,101,1)").run();
  const scheduled: { body: { userId: number; memeIds: string[] }; delay: number }[] = [];
  const env = { ...f.env, UPLOADS: { send: async (body: { userId: number; memeIds: string[] }, opts?: { delaySeconds: number }) => {
    scheduled.push({ body, delay: opts?.delaySeconds ?? 0 });
  } } } as unknown as Env;
  await queueUploads(env);
  expect(scheduled).toHaveLength(3);
  expect(scheduled.every(x => x.body.userId === 101 && x.body.memeIds.length === 1)).toBe(true);
  expect(scheduled.map(x => x.delay)).toEqual([0,4,7]);
  expect(await f.env.DB.prepare("SELECT SUM(upload_tries) AS n FROM memes WHERE user_id=202").first<number>("n")).toBe(0);
  scheduled.length = 0;
  await f.env.DB.prepare("UPDATE memes SET upload_at=NULL").run();
  Object.assign(env, { STORAGE_CHAT_ID: "-999" });
  await queueUploads(env);
  expect(scheduled).toHaveLength(5);
  expect(scheduled[0].body.userId).not.toBe(scheduled[1].body.userId);
  expect(scheduled[0].body.userId).toBe(scheduled[2].body.userId);
});

test("upload retry retains adoption and rejects foreign meme IDs", async () => {
  await f.meme("a",101); await f.meme("b",101); await f.meme("foreign",202);
  Object.assign(f.env, { STORAGE_CHAT_ID: "-999" });
  let calls = 0;
  const api = new Api("1:test");
  api.config.use(async () => {
    calls++;
    if (calls === 2) return { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } as never;
    return { ok: true, result: { message_id: calls, date: 0, chat: { id: -999, type: "channel" }, photo: [{ file_id: `file${calls}`, file_unique_id: `unique${calls}`, width: 1, height: 1 }] } } as never;
  });
  const body = { userId: 101, memeIds: ["a","b","foreign"] };
  await expect(uploadJob(f.env, api, body, 0)).rejects.toMatchObject({ parameters: { retry_after: 7 } });
  await uploadJob(f.env, api, body, 0);
  expect(calls).toBe(3);
  expect(await f.env.DB.prepare("SELECT file_id FROM memes WHERE id='a'").first<string>("file_id")).toBe("file1");
  expect(await f.env.DB.prepare("SELECT file_id FROM memes WHERE id='b'").first<string>("file_id")).toBe("file3");
  expect(await f.env.DB.prepare("SELECT file_id FROM memes WHERE id='foreign'").first<string>("file_id")).toBe("");
});
