import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { fixture, providerKey, vector } from "./fixture";
import type { Env } from "../../src/env";
import type { Ctx } from "../../src/bot";
import type { Job } from "../../src/queue";
import { Api } from "grammy";
import { saveAIConfig } from "../../src/aimodels";
import { resolveUser } from "../../src/auth";
import { DESCRIBE_MODELS } from "../../src/config";
import { setUserKey } from "../../src/userkey";
const { BATCH_DISABLED_ERROR, cancelImport, finishImport, pollImports, recoverBatchImports, retryFailed, startImport, submitImport } = await import("../../src/batch");
const { describeStage } = await import("../../src/ingest/describe");
const { handleBatch } = await import("../../src/queue");
const { embedStage } = await import("../../src/ingest/embed");
const { receiveMedia } = await import("../../src/ingest/receive");
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
  await providerKey(f.env, "openrouter", "test-key");
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

// Upstream d039880 defaults for the OpenRouter batch endpoint, independent of online routes.
test.each([
  ["medium", "openai/gpt-6-luna"],
  ["max", "google/gemini-4-argon"],
] as const)("new %s batches use the fixed OpenRouter model despite online routing and BYOK", async (tier, model) => {
  const account = await resolveUser(f.env, { id: 101, is_bot: false, first_name: "Fixture" });
  expect(account?.user.describe_tier).toBe("medium");
  await f.meme("photo", 101);
  if (tier === "max") await f.env.DB.prepare("UPDATE users SET describe_tier='max' WHERE id=101").run();
  expect(await saveAIConfig(f.env, {
    action: "route", workload: `photo_${tier}`, providerId: "openrouter", model: "google/gemini-3.8-flash",
  })).toBeNull();
  await setUserKey(f.env, 101, "ignored-legacy-key");
  await f.env.DB.prepare("INSERT INTO imports(id,user_id,status) VALUES ('imp',101,'submitting')").run();
  await f.env.DB.prepare("UPDATE memes SET title=NULL,status='describing',import_id='imp' WHERE id='photo'").run();
  const edit = spyOn(Api.prototype, "editMessageText").mockResolvedValue(true as never);
  let calls = 0;
  network.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    expect(String(input)).toBe("https://openrouter.ai/api/v1/batches");
    expect(new Request(String(input), init).headers.get("Authorization")).toBe("Bearer test-key");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(model);
    expect(body.requests[0].body.model).toBe(body.model);
    expect(body.requests[0].body.tools).toBeUndefined();
    return Response.json({ id: "batch-id", status: "in_progress" });
  }, { preconnect: fetch.preconnect }));
  try {
    await submitImport(Object.assign(f.env, { BATCH_ENABLED: "true" }), "imp");
    expect(calls).toBe(1);
    expect(await f.env.DB.prepare("SELECT status,key_source,model FROM imports WHERE id='imp'").first<Record<string, string>>())
      .toEqual({ status: "submitted", key_source: "global", model });
  } finally {
    edit.mockRestore();
  }
});

test("a blocked batch photo skips the rejected default model when its durable job runs", async () => {
  await submitted();
  f.env.BATCH_ENABLED = "true";
  await f.env.DB.prepare("UPDATE users SET describe_tier='max' WHERE id=101").run();
  await f.env.DB.prepare("UPDATE imports SET model=? WHERE id='imp'").bind(DESCRIBE_MODELS.max).run();
  const models: string[] = [];
  network.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === "https://openrouter.ai/api/v1/batches/remote-1") return Response.json({ id: "remote-1", status: "completed", results: [
      { custom_id: "photo", error: { message: "Gemini blocked the request: SAFETY" } },
    ] });
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      models.push(JSON.parse(String(init?.body)).model);
      return Response.json({ choices: [{ message: { content: '{"title":"Recovered photo"}' } }], usage: { cost: 0 } });
    }
    if (url === "https://openrouter.ai/api/v1/embeddings") return Response.json({ data: [{ index: 0, embedding: vector() }], usage: { cost: 0 } });
    unexpected.push(url); throw new Error(`Unexpected external call: ${url}`);
  }, { preconnect: fetch.preconnect }));
  await pollImports(f.env);
  const body = { type: "describe", memeId: "photo", gen: 0, from: 1, batchModel: DESCRIBE_MODELS.max } satisfies Job;
  expect(f.jobs).toEqual([body]);
  const ack = mock();
  const retry = mock();
  await handleBatch({ messages: [{ body, ack, retry, attempts: 1 }] } as unknown as MessageBatch<Job>, f.env);
  expect(ack).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
  expect(models).toEqual([DESCRIBE_MODELS.medium]);
  expect(await f.env.DB.prepare("SELECT status, title, import_id FROM memes WHERE id='photo'")
    .first<{ status: string; title: string; import_id: string | null }>()).toEqual({ status: "ready", title: "Recovered photo", import_id: null });
});

test("disabled batches stop unsubmitted work on startup and reject stale queue jobs", async () => {
  Object.assign(f.env, { BATCH_ENABLED: "false" });
  for (const id of ["collecting", "submitting", "stale", "described", "normal", "blocked"]) await f.meme(id, 101);
  await f.env.DB.exec("INSERT INTO imports(id,user_id,status) VALUES ('open',101,'collecting'),('queued',101,'submitting');");
  await f.env.DB.exec("UPDATE memes SET title=NULL,status='embedding',import_id='open' WHERE id='collecting';");
  await f.env.DB.exec("UPDATE memes SET title=NULL,status='describing',import_id='queued' WHERE id='submitting';");
  await f.env.DB.exec("UPDATE memes SET status='describing',import_id='queued' WHERE id='described';");
  await f.env.DB.exec("UPDATE memes SET status='describing',title=NULL WHERE id IN ('normal','blocked');");
  const staleJob = JSON.stringify({ type: "batch_submit", importId: "queued" });
  await f.env.DB.prepare("INSERT INTO batch_continuations(id,body) VALUES (?,?)").bind(staleJob, staleJob).run();

  expect(await startImport(f.env, 202)).toEqual({ created: false, count: 0 });
  expect(await finishImport(f.env, 101, 1)).toBe(false);
  expect(await cancelImport(f.env, 101)).toBeNull();
  await recoverBatchImports(f.env);
  expect((await f.env.DB.prepare("SELECT DISTINCT status,error FROM imports").all()).results).toEqual([{ status: "failed", error: BATCH_DISABLED_ERROR }]);
  expect(await retryFailed(f.env, 101, null)).toEqual({ photos: 0, others: 0 });
  expect(await f.env.DB.prepare("SELECT count(*) AS n FROM batch_continuations").first<number>("n")).toBe(0);
  expect(f.jobs).toEqual([{ type: "finish", memeId: "described", gen: 0 }]);

  // Simulate a stale batch_submit already on the queue (e.g. from a pre-change deployment).
  await f.env.DB.exec("INSERT INTO imports(id,user_id,status) VALUES ('late',101,'submitting');");
  await f.env.DB.exec("UPDATE memes SET title=NULL,status='describing',import_id='late' WHERE id='stale';");
  await submitImport(f.env, "late");
  await describeStage(f.env, "stale");
  await describeStage(f.env, "blocked", 1); // old batch policy detached content-blocked photos before enqueue
  await embedStage(f.env, "normal");
  expect((await f.env.DB.prepare("SELECT id FROM memes WHERE status='failed' ORDER BY id").all()).results)
    .toEqual(["blocked", "collecting", "stale", "submitting"].map(id => ({ id })));
  expect(f.jobs).toEqual([{ type: "finish", memeId: "described", gen: 0 }, { type: "describe", memeId: "normal", gen: 0 }]);
  f.env.BATCH_ENABLED = "true";
  await f.reopen();
  await recoverBatchImports(f.env);
  await submitImport(f.env, "queued");
  await submitImport(f.env, "late");
  await describeStage(f.env, "blocked", 1);
  expect((await f.env.DB.prepare("SELECT DISTINCT status,error FROM imports").all()).results).toEqual([{ status: "failed", error: BATCH_DISABLED_ERROR }]);
  expect(f.jobs).toEqual([{ type: "finish", memeId: "described", gen: 0 }, { type: "describe", memeId: "normal", gen: 0 }]);
  const { retryMeme } = await import("../../src/webapp");
  const { getMeme } = await import("../../src/db");
  for (const [enabled, id] of [["true", "stale"], ["false", "collecting"]] as const) {
    f.env.BATCH_ENABLED = enabled;
    const stopped = (await getMeme(f.env.DB, id))!;
    expect(stopped).toMatchObject({ import_id: expect.any(String), error: BATCH_DISABLED_ERROR });
    expect(await retryMeme(f.env, stopped)).toBe(true);
    expect(await getMeme(f.env.DB, id)).toMatchObject({ import_id: null, status: "embedding", error: null });
    expect(f.jobs.at(-1)).toEqual({ type: "embed", memeId: id, gen: stopped.gen });
  }
});

test("disabled startup recovers a known batch and bills successes once without retrying failures", async () => {
  Object.assign(f.env, { BATCH_ENABLED: "false" });
  await submitted();
  for (const id of ["failed", "blocked"]) await f.meme(id, 101);
  await f.env.DB.exec("UPDATE memes SET status='describing',title=NULL,import_id='imp' WHERE id!='photo';");
  await f.env.DB.exec("UPDATE imports SET status='processing';");
  let polls = 0;
  network.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://openrouter.ai/api/v1/batches/remote-1" || init?.method === "POST") {
      unexpected.push(String(input)); throw new Error(`Unexpected external call: ${input}`);
    }
    polls++;
    if (polls === 1) return Response.json({ id: "remote-1", status: "in_progress" });
    return Response.json({ id: "remote-1", status: "completed", usage: { cost: 0.125 }, results: [
      { custom_id: "photo", response: { body: { choices: [{ message: { content: '{"title":"Recovered otter"}' } }] } } },
      { custom_id: "failed", error: { message: "private-provider-error", metadata: { raw: "private-provider-raw" } } },
      { custom_id: "blocked", error: { message: "Gemini blocked the request: SAFETY" } },
    ] });
  }, { preconnect: fetch.preconnect }));
  await recoverBatchImports(f.env);
  await describeStage(f.env, "photo"); // stale full-price fallback must not preempt the known batch
  await pollImports(f.env);
  expect(await f.env.DB.prepare("SELECT status FROM imports WHERE id='imp'").first<string>("status")).toBe("submitted");
  expect(await f.env.DB.prepare("SELECT count(*) AS n FROM transactions").first<number>("n")).toBe(0);
  await pollImports(f.env);
  await pollImports(f.env);
  expect(polls).toBe(2);
  expect(f.jobs).toEqual([{ type: "batch_poll" }, { type: "finish", memeId: "photo", gen: 0 }]);
  expect(await f.env.DB.prepare("SELECT status,described,attempts,cost FROM imports WHERE id='imp'").first<Record<string, string | number>>())
    .toEqual({ status: "failed", described: 1, attempts: 1, cost: 0.125 });
  expect(await f.env.DB.prepare("SELECT error FROM imports WHERE id='imp'").first<string>("error"))
    .toBe("Batch provider reported an error");
  expect(await f.env.DB.prepare("SELECT count(*) AS n FROM transactions").first<number>("n")).toBe(1);
  expect(await f.env.DB.prepare("SELECT count(*) AS n FROM memes WHERE status='failed'").first<number>("n")).toBe(2);
});

test("forwarded photos use regular ingest even with a stale collecting batch", async () => {
  Object.assign(f.env, { BATCH_ENABLED: "false" });
  await f.env.DB.exec("INSERT INTO users(id,role) VALUES(101,'admin'); INSERT INTO imports(id,user_id,status) VALUES('open',101,'collecting');");
  const ctx = { user: { id: 101 }, lang: "en", msg: { message_id: 42, photo: [{ file_id: "tg", file_unique_id: "unique", width: 20, height: 20 }] },
    api: { raw: { sendWidget: async () => ({ message_id: 5 }) } },
    react: async () => { throw new Error("normal ingest should not send a batch reaction"); },
  } as unknown as Ctx;
  await receiveMedia(ctx, f.env);
  expect(await f.env.DB.prepare("SELECT import_id,status_msg_id FROM memes WHERE file_id='tg'").first<{ import_id: string | null; status_msg_id: number }>())
    .toEqual({ import_id: null, status_msg_id: 5 });
  expect(f.jobs).toEqual([{ type: "embed", memeId: expect.any(String) }]);
});

test("forwarding a stopped batch photo again after re-enabling detaches it for ordinary ingest", async () => {
  await f.meme("photo", 101);
  await f.env.DB.exec("INSERT INTO imports(id,user_id,status) VALUES('open',101,'collecting');");
  await f.env.DB.exec("UPDATE memes SET file_unique_id='unique',status='embedding',title=NULL,import_id='open' WHERE id='photo';");
  f.env.BATCH_ENABLED = "false";
  await recoverBatchImports(f.env);
  f.env.BATCH_ENABLED = "true";
  const ctx = { user: { id: 101 }, lang: "en", msg: { message_id: 42, photo: [{ file_id: "tg", file_unique_id: "unique", width: 20, height: 20 }] },
    api: { raw: { sendWidget: async () => ({ message_id: 5 }) } },
  } as unknown as Ctx;
  await receiveMedia(ctx, f.env);
  expect(await f.env.DB.prepare("SELECT status,import_id,error FROM memes WHERE id='photo'").first<{ status: string; import_id: string | null; error: string | null }>())
    .toEqual({ status: "embedding", import_id: null, error: null });
  expect(f.jobs).toEqual([{ type: "embed", memeId: "photo", gen: 1 }]);
});

test("ZIP photos without a provider batch use all ordinary ingest stages when batching is disabled", async () => {
  f.env.BATCH_ENABLED = "false";
  await f.meme("zip-photo", 101);
  await f.env.DB.exec(`UPDATE memes SET status='embedding', title=NULL, added_via='zip', sha256='${"a".repeat(64)}' WHERE id='zip-photo'`);
  const calls: string[] = [];
  network.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === "https://openrouter.ai/api/v1/embeddings") {
      const body = JSON.parse(String(init?.body));
      calls.push(typeof body.input[0] === "string" ? "embed-text" : "embed-image");
      return Response.json({ data: [{ index: 0, embedding: vector() }] });
    }
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      calls.push("describe");
      return Response.json({ choices: [{ message: { content: '{"title":"ZIP otter"}' } }] });
    }
    unexpected.push(url); throw new Error(`Unexpected external call: ${url}`);
  }, { preconnect: fetch.preconnect }));
  await embedStage(f.env, "zip-photo");
  expect(f.jobs).toEqual([{ type: "describe", memeId: "zip-photo", gen: 0 }]);
  await describeStage(f.env, "zip-photo");
  expect(calls).toEqual(["embed-image", "describe", "embed-text"]);
  expect(await f.env.DB.prepare("SELECT status,import_id,title FROM memes WHERE id='zip-photo'").first<{ status: string; import_id: string | null; title: string | null }>())
    .toEqual({ status: "ready", import_id: null, title: "ZIP otter" });
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
