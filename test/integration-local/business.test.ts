import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Use the deployment's existing compatibility shim; no OAuth behavior is mocked.
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { readdirSync } from "node:fs";
import { fixture, providerKey, vector } from "./fixture";
import { deleteMeme, getUser } from "../../src/db";
const { namespace, memeVectors, hashStage, embedStage } = await import("../../src/ingest/embed");
const { hybridSearch, keywordSearch } = await import("../../src/search/hybrid");
const { canUseAi, billingStatus } = await import("../../src/billing");
const { recordSpend } = await import("../../src/spend");
import { sign, signedMediaUrl, serveMedia } from "../../src/media";

let f: Awaited<ReturnType<typeof fixture>>;
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let unexpected: string[];
const previousSelfHosted = process.env.SELF_HOSTED;
beforeEach(async () => {
  unexpected = [];
  network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    unexpected.push(String(input));
    throw new Error(`Unexpected network call: ${input}`);
  }, { preconnect: fetch.preconnect }));
  f = await fixture();
});
afterEach(() => {
  network.mockRestore();
  if (previousSelfHosted === undefined) delete process.env.SELF_HOSTED;
  else process.env.SELF_HOSTED = previousSelfHosted;
  f?.close();
  expect(unexpected).toEqual([]); // also catches business code swallowing fetch errors
});

test("full migrations feed real FTS triggers, user-scoped search and restart", async () => {
  const files = readdirSync(new URL("../../migrations", import.meta.url)).filter(x => x.endsWith(".sql")).sort();
  const applied = await f.env.DB.prepare("SELECT filename FROM _runtime_migrations ORDER BY filename").all<{ filename: string }>();
  expect(applied.results.map(x => x.filename)).toEqual(files);
  await f.meme("alice", 101); await f.meme("bob", 202);
  expect((await keywordSearch(f.env, 101, "otter", 10)).map(m => m.id)).toEqual(["alice"]);
  await f.env.DB.prepare("UPDATE memes SET title = 'replacement narwhal' WHERE id = 'alice'").run();
  expect(await keywordSearch(f.env, 101, "otter", 10)).toEqual([]);
  await f.reopen();
  expect((await keywordSearch(f.env, 101, "narwhal", 10)).map(m => m.id)).toEqual(["alice"]);
  await deleteMeme(f.env, "alice");
  expect(await keywordSearch(f.env, 101, "narwhal", 10)).toEqual([]);
  expect((await keywordSearch(f.env, 202, "otter", 10)).map(m => m.id)).toEqual(["bob"]);
});

test("vector-only business search isolates owners and persists image/text vectors", async () => {
  await f.meme("alice", 101); await f.meme("bob", 202);
  await f.env.VECTORS.upsert([101,202].flatMap(user => ["i","t"].map(kind => ({
    id: `${user === 101 ? "alice" : "bob"}:${kind}`, namespace: namespace(user), values: vector(), metadata: { kind: "photo" },
  }))));
  await f.reopen();
  for (const [user, id] of [[101,"alice"],[202,"bob"]] as const) {
    expect((await hybridSearch(f.env, user, { vectors: [vector()], texts: [], limit: 10 })).map(m => m.id)).toEqual([id]);
    expect((await memeVectors(f.env, user, "alice,bob")).map(v => v.id).sort()).toEqual([`${id}:i`,`${id}:t`]);
  }
  await deleteMeme(f.env, "alice");
  expect(await f.env.VECTORS.getByIds(["alice:i","alice:t"])).toEqual([]);
  expect(await hybridSearch(f.env, 101, { vectors: [vector()], texts: [], limit: 10 })).toEqual([]);
  expect((await hybridSearch(f.env, 202, { vectors: [vector()], texts: [], limit: 10 })).map(m => m.id)).toEqual(["bob"]);
  expect(await f.env.MEDIA.get("u/101/alice.jpg")).toBeNull();
  expect(await f.env.MEDIA.get("u/202/bob.jpg")).not.toBeNull();
});

test("paid user without subscription can start AI in SELF_HOSTED without balance deductions", async () => {
  await f.meme("paid", 101);
  const user = (await getUser(f.env.DB, 101))!;
  expect([user.role,user.paid_until,user.balance,user.openrouter_key]).toEqual(["paid",null,0,null]);
  process.env.SELF_HOSTED = "false";
  expect(await canUseAi(f.env.DB, user)).toEqual({ ok: false, reason: "subscribe" });
  process.env.SELF_HOSTED = "true";
  expect(await canUseAi(f.env.DB, user)).toEqual({ ok: true });
  expect((await billingStatus(f.env, user)).active).toBe(true);
  await recordSpend(f.env, { userId: user.id, kind: "self-hosted" }, "model", "global", { cost: 0.25 });
  expect(await f.env.DB.prepare("SELECT from_allowance, from_balance FROM transactions WHERE user_id=?").bind(user.id)
    .first<{ from_allowance: number; from_balance: number }>())
    .toEqual({ from_allowance: 0, from_balance: 0 });
});

test("real embedding stage links volume bytes, mock AI, spend ledger, vectors and queued continuation", async () => {
  process.env.SELF_HOSTED = "true";
  await f.meme("ingest", 101);
  await f.env.DB.prepare("UPDATE memes SET status='embedding', title=NULL WHERE id='ingest'").run();
  await providerKey(f.env, "openrouter", "acceptance-fake-key");
  let embeddings = 0;
  network.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== "https://openrouter.ai/api/v1/embeddings") {
      unexpected.push(String(input)); throw new Error(`Unexpected network call: ${input}`);
    }
    embeddings++;
    const body = JSON.parse(String(init?.body));
    expect(body.dimensions).toBe(1536);
    expect(body.user).toBe("101");
    expect(body.input[0].content[0].image_url.url).toBe("data:image/jpeg;base64,/9gAAQIDBP/Z");
    return Response.json({ data: [{ index: 0, embedding: vector() }], usage: { cost: 0.01, prompt_tokens: 10 } });
  }, { preconnect: fetch.preconnect }));
  await embedStage(f.env, "ingest");
  expect(embeddings).toBe(1);
  expect(await f.env.DB.prepare("SELECT status FROM memes WHERE id='ingest'").first<string>("status")).toBe("describing");
  expect(f.jobs).toEqual([{ type: "describe", memeId: "ingest", gen: 0 }]);
  const spend = await f.env.DB.prepare("SELECT user_id, cost, from_balance FROM transactions").all();
  expect(spend.results).toEqual([{ user_id: 101, cost: 0.01, from_balance: 0 }]);
  await f.reopen();
  expect((await hybridSearch(f.env, 101, { vectors: [vector()], texts: [], limit: 10 })).map(m => m.id)).toEqual(["ingest"]);
});

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
test("signed media handler serves persisted binary file/preview and rejects tampering/expiry", async () => {
  const meme = await f.meme("alice", 101);
  await hashStage(f.env, meme.id); // real business backfill reads volume, never Telegram
  expect(await f.env.DB.prepare("SELECT length(sha256) AS n FROM memes WHERE id = 'alice'").first<number>("n")).toBe(64);
  const url = await signedMediaUrl(f.env, meme, "file", 60);
  await f.reopen();
  const response = await serveMedia(new Request(url), f.env, ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255,216,0,1,2,3,4,255,217]));
  const preview = await serveMedia(new Request(await signedMediaUrl(f.env, meme, "preview", 60)), f.env, ctx);
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array([255,216,99,255,217]));
  const past = Math.floor(Date.now()/1000)-10;
  for (const bad of [url.replace("alice.file", "bob.file"), url.replace(".file.", ".preview."), url.replace(/s=[^&]+/, "s=AAAA"),
    `${f.env.PUBLIC_URL}/media/alice.file.jpg?e=${past}&s=${await sign(f.env, `media|alice|file|${past}`)}`]) {
    expect((await serveMedia(new Request(bad), f.env, ctx)).status).toBe(404);
  }
});

test("signed media HTTP Range returns only requested bytes (acceptance requirement)", async () => {
  const meme = await f.meme("video", 101);
  const url = await signedMediaUrl(f.env, meme, "file", 60);
  const response = await serveMedia(new Request(url, { headers: { Range: "bytes=2-5" } }), f.env, ctx);
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 2-5/9");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0,1,2,3]));
});
