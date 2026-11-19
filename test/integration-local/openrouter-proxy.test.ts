import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { Api } from "grammy";
import { fixture } from "./fixture";
const { chat, embed, createBatch, getBatch, OpenRouterError } = await import("../../src/openrouter");
const { oauthCallback, oauthUrl, decrypt, setUserKey } = await import("../../src/userkey");

const userId = 91473;
const spend = { userId, kind: "proxy-test" };
const base = "https://openrouter.ai/api/v1";
const oldProxy = process.env.OUTBOUND_PROXY_URL;
let f: Awaited<ReturnType<typeof fixture>>;
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let notice: ReturnType<typeof spyOn>;
let calls: { url: string; init?: RequestInit }[];

beforeEach(async () => {
  process.env.OUTBOUND_PROXY_URL = "";
  calls = [];
  network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    throw new Error("Unexpected network request (network disabled in this test)");
  }, { preconnect: fetch.preconnect }));
  // grammY captures its fetch on import; intercept notifications before transport.
  notice = spyOn(Api.prototype, "sendMessage").mockResolvedValue({ message_id: 1 } as never);
  f = await fixture();
  f.env.OPENROUTER_API_KEY = "fake-global-key";
  await f.env.DB.prepare("INSERT INTO users (id, role) VALUES (?, 'user')").bind(userId).run();
  await setUserKey(f.env, userId, null);
});

afterEach(() => {
  network.mockRestore();
  notice.mockRestore();
  f?.close();
  if (oldProxy === undefined) delete process.env.OUTBOUND_PROXY_URL;
  else process.env.OUTBOUND_PROXY_URL = oldProxy;
});

function respond(handler: (url: string, init?: RequestInit) => Response) {
  network.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }, { preconnect: fetch.preconnect }));
}

function headerValue(headers: RequestInit["headers"], name: string) {
  const normalized = new Headers();
  if (headers) {
    if (Symbol.iterator in headers) {
      for (const entry of headers) {
        const pair = Array.from(entry);
        if (pair.length !== 2) throw new TypeError("Expected a header name/value pair");
        normalized.append(pair[0]!, pair[1]!);
      }
    } else {
      for (const [key, value] of Object.entries(headers)) normalized.append(key, value);
    }
  }
  return normalized.get(name);
}

async function callbackRequest() {
  const authorize = new URL(await oauthUrl(f.env, userId, "web"));
  expect(authorize.origin + authorize.pathname).toBe("https://openrouter.ai/auth");
  return new Request(`${f.env.PUBLIC_URL}/oauth/callback?code=fake-code&state=${authorize.searchParams.get("state")}`);
}

test("empty shared proxy preserves native fetch, headers, usage accounting and batch keys", async () => {
  const signal = new AbortController().signal;
  respond((url) => {
    if (url === `${base}/chat/completions`) return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { cost: 0.01, prompt_tokens: 7 } });
    if (url === `${base}/embeddings`) return Response.json({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }], usage: { cost: 0.02 } });
    if (url === `${base}/batches` || url === `${base}/batches/batch%2Fid`) return Response.json({ id: "batch/id", status: "in_progress" });
    throw new Error(`Unexpected mocked endpoint: ${url}`);
  });
  expect((await chat(f.env, { model: "test-model", messages: [] }, spend, signal)).content).toBe("ok");
  expect(calls[0]!.init?.signal).toBe(signal);
  expect(JSON.parse(String(calls[0]!.init?.body)).user).toBe(String(userId));
  expect(headerValue(calls[0]!.init?.headers, "Authorization")).toBe("Bearer fake-global-key");
  expect(headerValue(calls[0]!.init?.headers, "HTTP-Referer")).toBe("https://github.com/cofob/memesave-bot");
  await setUserKey(f.env, userId, "fake-user-key");
  expect(await embed(f.env, ["text"], "search_query", spend)).toEqual([[1], [2]]);
  const requests = [{ custom_id: "one", body: { model: "test-model" } }];
  const created = await createBatch(f.env, userId, { model: "test-model" }, requests);
  expect(created.source).toBe("user");
  expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ model: "test-model", requests });
  expect(Object.keys(JSON.parse(String(calls[2]!.init?.body))).at(-1)).toBe("requests");
  await getBatch(f.env, userId, "global", "batch/id");
  expect(calls.map(c => headerValue(c.init?.headers, "Authorization"))).toEqual([
    "Bearer fake-global-key", "Bearer fake-user-key", "Bearer fake-user-key", "Bearer fake-global-key",
  ]);
  const rows = await f.env.DB.prepare("SELECT key_source, cost, prompt_tokens FROM transactions WHERE user_id = ? ORDER BY id").bind(userId).all();
  expect(rows.results).toEqual([
    { key_source: "global", cost: 0.01, prompt_tokens: 7 },
    { key_source: "user", cost: 0.02, prompt_tokens: null },
  ]);
});

test("empty proxy retains OAuth PKCE exchange and encrypted key persistence", async () => {
  const request = await callbackRequest();
  expect(calls).toHaveLength(0); // authorize URL is for the browser, not server fetch
  respond((url, init) => {
    expect(url).toBe(`${base}/auth/keys`);
    expect(init?.method).toBe("POST");
    expect(headerValue(init?.headers, "Authorization")).toBeNull();
    expect(JSON.parse(String(init?.body))).toMatchObject({ code: "fake-code", code_challenge_method: "S256" });
    expect(JSON.parse(String(init?.body)).code_verifier).toBeString();
    return Response.json({ key: "fake-oauth-key" });
  });
  const response = await oauthCallback(request, f.env);
  expect(response.headers.get("Location")).toBe(`${f.env.PUBLIC_URL}/?key=connected`);
  const sealed = await f.env.DB.prepare("SELECT openrouter_key FROM users WHERE id = ?").bind(userId).first<string>("openrouter_key");
  expect(await decrypt(f.env.ENCRYPTION_KEY, sealed!)).toBe("fake-oauth-key");
  expect(notice).toHaveBeenCalledTimes(1);
});

test("native mock responses retain transient retry and OpenRouter error semantics", async () => {
  let attempts = 0;
  respond(() => ++attempts === 1
    ? Response.json({ error: { message: "try again", code: 429 } }, { status: 429 })
    : Response.json({ choices: [{ message: { role: "assistant", content: "retried" } }] }));
  expect((await chat(f.env, { model: "test-model", messages: [] }, spend)).content).toBe("retried");
  expect(attempts).toBe(2);
  respond(() => Response.json({ error: { message: "bad input" } }, { status: 400 }));
  await expect(chat(f.env, { model: "test-model", messages: [] }, spend)).rejects.toBeInstanceOf(OpenRouterError);
  expect(calls).toHaveLength(3);
});

for (const endpoint of ["chat", "embeddings", "batch create", "batch status", "OAuth exchange"] as const) {
  test(`configured shared proxy is used for ${endpoint} (preflight rejects before any network)`, async () => {
    const request = endpoint === "OAuth exchange" ? await callbackRequest() : undefined;
    // Invalid protocol guarantees a transport preflight failure, never DNS/socket IO.
    process.env.OUTBOUND_PROXY_URL = "ftp://proxy.invalid";
    const run = () => {
      switch (endpoint) {
        case "chat": return chat(f.env, { model: "test-model", messages: [] }, spend);
        case "embeddings": return embed(f.env, ["text"], "search_query", spend);
        case "batch create": return createBatch(f.env, userId, {}, []);
        case "batch status": return getBatch(f.env, userId, "global", "remote-id");
        case "OAuth exchange": return oauthCallback(request!, f.env);
      }
    };
    await expect(run()).rejects.toThrow("OUTBOUND_PROXY_URL must be an HTTP, HTTPS or SOCKS5 proxy URL");
    expect(calls).toEqual([]);
    expect(notice).not.toHaveBeenCalled();
  });
}
