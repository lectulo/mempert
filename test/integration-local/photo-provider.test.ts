import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { connect } from "node:net";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import * as transport from "../../src/aiprovidertransport";
import { DESCRIBE_FALLBACKS, DESCRIBE_MODELS, DESCRIBE_UNCENSORED, DESCRIBE_VIDEO_FALLBACKS, MODELS } from "../../src/config";
import { createCompatibleProvider, fixture, providerKey, vector } from "./fixture";
import { saveAIConfig } from "../../src/aimodels";
const { describeStage, finishStage } = await import("../../src/ingest/describe");
const { chat } = await import("../../src/openrouter");
const { setUserKey } = await import("../../src/userkey");

const userId = 91474;
const visionId = "fixture-vision";
const visionHost = "vision-fixture.example";
const visionBase = `https://${visionHost}/v1`;
const visionChat = `${visionBase}/chat/completions`;
const visionModels = { medium: "fixture-vision-standard", max: "fixture-vision-large" };
const openRouterBase = "https://openrouter.ai/api/v1";
const openRouterChat = `${openRouterBase}/chat/completions`;
const embeddings = `${openRouterBase}/embeddings`;
const firstImage = "data:image/jpeg;base64,/9gAAQIDBP/Z";
const secondImage = "data:image/jpeg;base64,/9gJ/9k=";
const customKey = "fake-photo-key";
const globalKey = "fake-global-key";
const userKey = "fake-byok-key";
const oldProxy = process.env.OUTBOUND_PROXY_URL;
const customAIPost = transport.customAIPost;

type Call = { url: string; method: string; headers: Headers; body: any; redirect?: Request["redirect"] };
let f: Awaited<ReturnType<typeof fixture>>;
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let customNetwork: ReturnType<typeof spyOn<typeof transport, "customAIPost">>;
let server: ReturnType<typeof createServer>;
let calls: Call[];
let respond: (url: string) => Response;

beforeEach(async () => {
  process.env.OUTBOUND_PROXY_URL = "";
  calls = [];
  respond = (url) => { throw new Error(`Unexpected mocked endpoint: ${url}`); };
  server = createServer(async (req, res) => {
    let response: Response;
    try {
      const url = `https://${req.headers.host}${req.url}`;
      const body: Buffer[] = [];
      for await (const chunk of req) body.push(chunk);
      calls.push({ url, method: req.method!, headers: new Headers(req.headers as Record<string, string>),
        body: JSON.parse(Buffer.concat(body).toString()) });
      response = respond(url);
    } catch {
      response = new Response(null, { status: 500 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  // Keep the real custom transport; substitute only public DNS and the TLS socket.
  customNetwork = spyOn(transport, "customAIPost").mockImplementation((base, body, key, signal) =>
    customAIPost(base, body, key, signal, async (name) => {
      expect(name).toBe(`${visionHost}.`);
      return [{ address: "8.8.8.8" }];
    }, (options, callback) => {
      expect(options).toMatchObject({ hostname: "8.8.8.8", servername: visionHost, protocol: "https:" });
      const socket = connect(address.port, "127.0.0.1");
      const failed = (err: Error) => callback(err, null);
      socket.once("error", failed);
      socket.once("connect", () => { socket.off("error", failed); callback(null, socket); });
    }));
  network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const call: Call = { url: request.url, method: request.method, headers: request.headers, body: null, redirect: request.redirect };
    calls.push(call);
    if (request.body) call.body = await request.json();
    return respond(call.url);
  }, { preconnect: fetch.preconnect }));
  f = await fixture();
  await createCompatibleProvider(f.env, visionId, visionBase, customKey);
  await providerKey(f.env, "openrouter", globalKey);
  for (const [tier, model] of Object.entries(visionModels)) {
    expect(await saveAIConfig(f.env, { action: "model", providerId: visionId, model,
      prompt: 1.5, completion: 3, cacheWrite: 2, cacheRead: 0.25 })).toBeNull();
    expect(await saveAIConfig(f.env, { action: "route", workload: `photo_${tier}`, providerId: visionId, model })).toBeNull();
  }
  await f.env.DB.prepare("INSERT INTO users (id, role) VALUES (?, 'paid')").bind(userId).run();
  await setUserKey(f.env, userId, null); // clear the per-user key cache between tests
});

afterEach(async () => {
  network?.mockRestore();
  customNetwork?.mockRestore();
  if (oldProxy === undefined) delete process.env.OUTBOUND_PROXY_URL;
  else process.env.OUTBOUND_PROXY_URL = oldProxy;
  f?.close();
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

async function photo(id: string) {
  const meme = await f.meme(id, userId);
  await f.env.DB.prepare("UPDATE memes SET status = 'describing', title = NULL WHERE id = ?").bind(id).run();
  return meme;
}

async function album() {
  const second = await photo("second");
  await photo("first");
  await f.env.MEDIA.put(second.r2_file!, new Uint8Array([255, 216, 9, 255, 217]), { httpMetadata: { contentType: "image/jpeg" } });
  await f.env.DB.batch([
    f.env.DB.prepare("INSERT INTO posts (id, user_id, media_group_id, status, updated_at) VALUES ('album', ?, 'group', 'skipped', unixepoch() - 120)").bind(userId),
    f.env.DB.prepare("INSERT INTO post_items (post_id, meme_id, position) VALUES ('album', 'second', 2), ('album', 'first', 1)"),
  ]);
}

function description(title: string) {
  return {
    title, ocr_text: "", speech_text: "", language: "none", description: "An otter in water.",
    meme_context: "", cultural_meaning: "", tags: ["otter"], search_phrases: ["swimming otter"], porn: false,
  };
}

function completion(answer: unknown) {
  return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(answer) } }] });
}

function embedding() {
  return Response.json({ data: [{ index: 0, embedding: vector() }] });
}

function expectOpenRouter(call: Call, key: string) {
  expect(call.method).toBe("POST");
  expect(call.redirect).toBe("error");
  expect(call.headers.get("Authorization")).toBe(`Bearer ${key}`);
  expect(call.headers.get("HTTP-Referer")).toBe("https://github.com/cofob/memesave-bot");
  expect(call.headers.get("X-Title")).toBe("memesave-bot");
  expect(call.body.user).toBe(String(userId));
}

function expectEmbedding(call: Call, key: string, title: string) {
  expectOpenRouter(call, key);
  expect(call.body).toMatchObject({ model: "google/gemini-embedding-2", dimensions: 1536, input_type: "search_document" });
  expect(call.body.input).toHaveLength(1);
  expect(call.body.input[0]).toContain(title);
}

function row(id: string) {
  return f.env.DB.prepare("SELECT status, title FROM memes WHERE id = ?").bind(id).first<{ status: string; title: string | null }>();
}

for (const tier of ["max", "medium"] as const) {
  for (const isAlbum of [false, true]) {
    test(`${tier}: ${isAlbum ? "album" : "single photo"} uses custom vision, then OpenRouter embeddings`, async () => {
      await f.env.DB.prepare("UPDATE users SET describe_tier = ? WHERE id = ?").bind(tier, userId).run();
      if (isAlbum) await album();
      else await photo("first");
      // OpenRouter's shared transport would reject this proxy before reaching native fetch.
      // The custom request must bypass it; re-enable the normal mocked transport for finishStage.
      process.env.OUTBOUND_PROXY_URL = "ftp://proxy.invalid";
      respond = (url) => {
        if (url === visionChat) {
          process.env.OUTBOUND_PROXY_URL = "";
          return completion(isAlbum ? { items: [description("First otter"), description("Second otter")] } : description("First otter"));
        }
        if (url === embeddings) return embedding();
        throw new Error(`Unexpected mocked endpoint: ${url}`);
      };

      await describeStage(f.env, "first");

      expect(calls.map((call) => call.url)).toEqual([visionChat, embeddings]);
      const chat = calls[0]!;
      expect(chat.method).toBe("POST");
      expect(chat.headers.get("Authorization")).toBe(`Bearer ${customKey}`);
      expect(chat.headers.get("HTTP-Referer")).toBeNull();
      expect(chat.headers.get("X-Title")).toBeNull();
      expect(chat.body.model).toBe(visionModels[tier]);
      expect(chat.body).not.toHaveProperty("user");
      expect(chat.body).not.toHaveProperty("tools");
      const userMessage = chat.body.messages.find((message: { role: string }) => message.role === "user");
      expect(userMessage.content.filter((part: { type: string }) => part.type === "image_url")
        .map((part: { image_url: { url: string } }) => part.image_url.url)).toEqual(isAlbum ? [firstImage, secondImage] : [firstImage]);
      const format = chat.body.response_format;
      expect(format.type).toBe("json_schema");
      const schema = format.json_schema.schema;
      expect(schema.type).toBe("object");
      if (isAlbum) expect(schema.properties.items.type).toBe("array");
      const item = isAlbum ? schema.properties.items.items : schema;
      expect(item.properties.title.type).toBe("string");

      expectEmbedding(calls[1]!, globalKey, "First otter");
      expect(await row("first")).toEqual({ status: "ready", title: "First otter" });
      if (isAlbum) {
        expect(await row("second")).toEqual({ status: "describing", title: "Second otter" });
        expect(f.jobs).toEqual([{ type: "finish", memeId: "second", gen: 0 }]);
        await finishStage(f.env, "second");
        expect(calls.map((call) => call.url)).toEqual([visionChat, embeddings, embeddings]);
        expectEmbedding(calls[2]!, globalKey, "Second otter");
        expect(await row("second")).toEqual({ status: "ready", title: "Second otter" });
      }
    });
  }
}

test("changing the photo route takes effect with DB credentials despite stored BYOK", async () => {
  await photo("first");
  await f.env.DB.prepare("UPDATE users SET describe_tier='max' WHERE id=?").bind(userId).run();
  await setUserKey(f.env, userId, userKey);
  expect(await saveAIConfig(f.env, { action: "route", workload: "photo_max", providerId: "openrouter", model: DESCRIBE_MODELS.max })).toBeNull();
  respond = (url) => {
    if (url === openRouterChat) return completion(description("BYOK otter"));
    if (url === embeddings) return embedding();
    throw new Error(`Unexpected mocked endpoint: ${url}`);
  };

  await describeStage(f.env, "first");

  expect(calls.map((call) => call.url)).toEqual([openRouterChat, embeddings]);
  expectOpenRouter(calls[0]!, globalKey);
  expect(calls[0]!.body.model).toBe(DESCRIBE_MODELS.max);
  expect(calls[0]!.body.tools.map((t: { type: string }) => t.type)).toEqual(["openrouter:web_search", "openrouter:web_fetch"]);
  expectEmbedding(calls[1]!, globalKey, "BYOK otter");
  expect(await row("first")).toEqual({ status: "ready", title: "BYOK otter" });
});

test("custom photo HTTP error does not fall back to a paid OpenRouter description", async () => {
  await photo("first");
  respond = (url) => {
    // A policy error would be eligible for the normal OpenRouter model fallback.
    if (url === visionChat) return Response.json({ error: { message: "blocked by content policy" } }, { status: 403 });
    if (url === openRouterChat) return completion(description("Unexpected paid fallback"));
    if (url === embeddings) return embedding();
    throw new Error(`Unexpected mocked endpoint: ${url}`);
  };

  await expect(describeStage(f.env, "first")).rejects.toThrow();

  expect(calls.length).toBeGreaterThan(0);
  expect([...new Set(calls.map((call) => call.url))]).toEqual([visionChat]);
  expect(await row("first")).toEqual({ status: "describing", title: null });
});

test("custom photo redirects do not forward media or credentials", async () => {
  await photo("first");
  respond = () => Response.redirect(`${visionBase}/elsewhere`, 307);
  await expect(describeStage(f.env, "first")).rejects.toThrow("AI provider redirects are not allowed");
  expect(calls.map((call) => call.url)).toEqual([visionChat]);
  expect(await row("first")).toEqual({ status: "describing", title: null });
});

test("a custom model on OpenRouter does not use default fallbacks, even for a blocked batch photo", async () => {
  const model = MODELS.describeVideo; // seeded OpenRouter model, but not the default for photo_max
  await photo("first");
  expect(await saveAIConfig(f.env, { action: "route", workload: "photo_max", providerId: "openrouter", model })).toBeNull();
  respond = () => Response.json({ error: { message: "content policy" } }, { status: 400 });
  await expect(describeStage(f.env, "first", 1, false, 0, DESCRIBE_MODELS.max)).rejects.toThrow("blocked by provider policy");
  expect(calls.map((call) => [call.url, call.body.model])).toEqual([[openRouterChat, model]]);
});

test.each([
  ["default rejected", "openrouter", DESCRIBE_MODELS.max, DESCRIBE_MODELS.max, DESCRIBE_FALLBACKS[0], openRouterChat],
  ["tier changed", "openrouter", DESCRIBE_MODELS.max, DESCRIBE_MODELS.medium, DESCRIBE_MODELS.max, openRouterChat],
  ["older queued job", "openrouter", DESCRIBE_MODELS.max, undefined, DESCRIBE_FALLBACKS[0], openRouterChat],
  ["custom route", visionId, visionModels.max, DESCRIBE_MODELS.max, visionModels.max, visionChat],
])("blocked batch recovery respects model selection: %s", async (_name, providerId, model, batchModel, expected, endpoint) => {
  await photo("first");
  expect(await saveAIConfig(f.env, { action: "route", workload: "photo_max", providerId, model })).toBeNull();
  respond = (url) => url === embeddings ? embedding() : completion(description("Recovered otter"));
  await describeStage(f.env, "first", 1, false, 0, batchModel);
  expect(calls.map((call) => call.url)).toEqual([endpoint, embeddings]);
  expect(calls[0]!.body.model).toBe(expected);
  if (endpoint === openRouterChat) expectOpenRouter(calls[0]!, globalKey);
  expect(await row("first")).toEqual({ status: "ready", title: "Recovered otter" });
});

test("default photo recovery retries transient failures and bills the fallback's own rate", async () => {
  const fallback = DESCRIBE_MODELS.medium;
  await photo("first");
  expect(await saveAIConfig(f.env, { action: "route", workload: "photo_max", providerId: "openrouter", model: DESCRIBE_MODELS.max })).toBeNull();
  expect(await saveAIConfig(f.env, { action: "model", providerId: "openrouter", model: fallback, prompt: 3, completion: 0, cacheWrite: 0, cacheRead: 0 })).toBeNull();
  respond = (url) => {
    if (url === embeddings) return embedding();
    if (calls.at(-1)!.body.model === DESCRIBE_MODELS.max) return Response.json({ error: { message: "rate limit" } }, { status: 429 });
    return Response.json({ choices: [{ message: { content: '{"title":"Recovered otter"}' } }], usage: { prompt_tokens: 1000 } });
  };
  await describeStage(f.env, "first");
  expect(calls.map((call) => call.body.model)).toEqual([DESCRIBE_MODELS.max, DESCRIBE_MODELS.max, fallback, MODELS.embed]);
  expect(await f.env.DB.prepare("SELECT model, cost FROM transactions WHERE kind='describe'")
    .first<{ model: string; cost: number }>()).toEqual({ model: fallback, cost: 0.003 });
});

test("default photo recovery handles nested provider policy errors and empty answers", async () => {
  await photo("first");
  expect(await saveAIConfig(f.env, { action: "route", workload: "photo_max", providerId: "openrouter", model: DESCRIBE_MODELS.max })).toBeNull();
  respond = (url) => {
    if (url === embeddings) return embedding();
    if (calls.length === 1) return Response.json({ choices: [{ error: { code: 400, metadata: { raw: "PROHIBITED" } } }] });
    if (calls.length === 2) return Response.json({ choices: [{ message: { content: " " } }] });
    return completion(description("Recovered otter"));
  };
  await describeStage(f.env, "first");
  expect(calls.map((call) => call.body.model)).toEqual([DESCRIBE_MODELS.max, ...DESCRIBE_FALLBACKS, MODELS.embed]);
  expect(await row("first")).toEqual({ status: "ready", title: "Recovered otter" });
});

for (const scenario of ["preview", "no preview", "custom model"] as const) {
  test(`video recovery: ${scenario}`, async () => {
    const meme = await photo("clip");
    const hasPreview = scenario !== "no preview";
    const custom = scenario === "custom model";
    const preview = hasPreview ? "clip.jpg" : null;
    await f.env.MEDIA.put(meme.r2_file!, "VIDEO", { httpMetadata: { contentType: "video/mp4" } });
    if (preview) await f.env.MEDIA.put(preview, "FRAME", { httpMetadata: { contentType: "image/jpeg" } });
    await f.env.DB.prepare("UPDATE memes SET kind='video', file_size=5, r2_preview=? WHERE id='clip'").bind(preview).run();
    const primary = custom ? DESCRIBE_VIDEO_FALLBACKS[0] : MODELS.describeVideo;
    if (custom) expect(await saveAIConfig(f.env, { action: "route", workload: "video", providerId: "openrouter", model: primary })).toBeNull();
    respond = (url) => {
      if (url === embeddings) return embedding();
      if (calls.at(-1)!.body.model === DESCRIBE_UNCENSORED) return completion(description("Recovered clip"));
      return Response.json({ choices: [{ message: { content: null, refusal: "No" } }] });
    };
    if (scenario === "preview") await describeStage(f.env, "clip");
    else await expect(describeStage(f.env, "clip")).rejects.toThrow("refused");
    const chatCalls = calls.filter((call) => call.url !== embeddings);
    expect(chatCalls.map((call) => call.body.model)).toEqual(custom ? [primary] : [primary, ...DESCRIBE_VIDEO_FALLBACKS,
      ...(hasPreview ? [DESCRIBE_UNCENSORED] : [])]);
    for (const call of chatCalls) expectOpenRouter(call, globalKey);
    const mediaTypes = chatCalls.map((call) => call.body.messages[1].content.map((part: { type: string }) => part.type));
    for (const parts of scenario === "preview" ? mediaTypes.slice(0, -1) : mediaTypes) expect(parts).toContain("video_url");
    if (scenario === "preview") {
      expect(mediaTypes.at(-1)).toEqual(["text", "text", "image_url"]);
      expect(chatCalls.at(-1)!.body.messages[1].content.at(-1).image_url.url).toBe("data:image/jpeg;base64,RlJBTUU=");
      expect(await row("clip")).toEqual({ status: "ready", title: "Recovered clip" });
    }
  });
}

test("a photo route without a DB credential fails before any completion request", async () => {
  await photo("first");
  await f.env.DB.prepare("UPDATE ai_providers SET sealed_key=NULL WHERE id=?").bind(visionId).run();
  await expect(describeStage(f.env, "first")).rejects.toThrow("AI route unavailable: photo_max");
  expect(calls).toEqual([]);
});

test("compatible agent keeps function tools and records configured token pricing", async () => {
  expect(await saveAIConfig(f.env, { action: "route", workload: "search_agent", providerId: visionId, model: visionModels.medium })).toBeNull();
  respond = () => Response.json({ choices: [{ message: { content: "done" } }], usage: {
    prompt_tokens: 100_000, completion_tokens: 25_000,
    prompt_tokens_details: { cached_tokens: 50_000, cache_write_tokens: 10_000 },
  } });
  const tools = [{ type: "function", function: { name: "search" } }];
  await chat(f.env, "search_agent", {
    messages: [{ role: "assistant", content: null, reasoning_details: [{ opaque: true }] }],
    tools: [...tools, { type: "openrouter:web_search" }], tool_choice: "auto",
    provider: { sort: "latency" }, reasoning: { enabled: false }, plugins: [],
  }, { userId, kind: "agent_step" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ model: visionModels.medium, tools, tool_choice: "auto", messages: [{ role: "assistant", content: null }] });
  const ledger = await f.env.DB.prepare("SELECT key_source, model, cost FROM transactions WHERE kind='agent_step'")
    .first<{ key_source: string; model: string; cost: number }>();
  expect(ledger).toMatchObject({ key_source: "global", model: visionModels.medium });
  expect(ledger?.cost).toBeCloseTo(0.1675, 6);
});
