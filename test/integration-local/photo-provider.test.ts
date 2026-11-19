import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { DESCRIBE_MODELS, MODELS } from "../../src/config";
import { fixture, vector } from "./fixture";
const { describeStage, finishStage } = await import("../../src/ingest/describe");
const { setUserKey } = await import("../../src/userkey");

const userId = 91474;
const visionBase = "https://vision.invalid/v1";
const visionChat = `${visionBase}/chat/completions`;
const openRouterBase = "https://openrouter.ai/api/v1";
const openRouterChat = `${openRouterBase}/chat/completions`;
const embeddings = `${openRouterBase}/embeddings`;
const firstImage = "data:image/jpeg;base64,/9gAAQIDBP/Z";
const secondImage = "data:image/jpeg;base64,/9gJ/9k=";
const customKey = "fake-photo-key";
const globalKey = "fake-global-key";
const userKey = "fake-byok-key";
const photoModel = "fake-vision-model";
const oldProxy = process.env.OUTBOUND_PROXY_URL;

type Call = { url: string; method: string; headers: Headers; body: any };
let f: Awaited<ReturnType<typeof fixture>>;
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let calls: Call[];
let respond: (url: string) => Response;

beforeEach(async () => {
  process.env.OUTBOUND_PROXY_URL = "";
  calls = [];
  respond = (url) => { throw new Error(`Unexpected mocked endpoint: ${url}`); };
  network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const call: Call = { url: request.url, method: request.method, headers: request.headers, body: null };
    calls.push(call);
    if (request.body) call.body = await request.json();
    return respond(call.url);
  }, { preconnect: fetch.preconnect }));
  f = await fixture();
  Object.assign(f.env, {
    PHOTO_API_BASE_URL: visionBase, PHOTO_API_KEY: customKey, PHOTO_MODEL: photoModel,
    OPENROUTER_API_KEY: globalKey,
  });
  await f.env.DB.prepare("INSERT INTO users (id, role) VALUES (?, 'paid')").bind(userId).run();
  await setUserKey(f.env, userId, null); // clear the per-user key cache between tests
});

afterEach(() => {
  network.mockRestore();
  if (oldProxy === undefined) delete process.env.OUTBOUND_PROXY_URL;
  else process.env.OUTBOUND_PROXY_URL = oldProxy;
  f?.close();
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
  expect(call.headers.get("Authorization")).toBe(`Bearer ${key}`);
  expect(call.headers.get("HTTP-Referer")).toBe("https://github.com/cofob/memesave-bot");
  expect(call.headers.get("X-Title")).toBe("memesave-bot");
  expect(call.body.user).toBe(String(userId));
}

function expectEmbedding(call: Call, key: string, title: string) {
  expectOpenRouter(call, key);
  expect(call.body).toMatchObject({ model: MODELS.embed, dimensions: 1536, input_type: "search_document" });
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
      expect(chat.body.model).toBe(photoModel);
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

test("connected BYOK uses OpenRouter for photo descriptions despite the custom override", async () => {
  await photo("first");
  await setUserKey(f.env, userId, userKey);
  respond = (url) => {
    if (url === openRouterChat) return completion(description("BYOK otter"));
    if (url === embeddings) return embedding();
    throw new Error(`Unexpected mocked endpoint: ${url}`);
  };

  await describeStage(f.env, "first");

  expect(calls.map((call) => call.url)).toEqual([openRouterChat, embeddings]);
  expectOpenRouter(calls[0]!, userKey);
  expect(calls[0]!.body.model).toBe(DESCRIBE_MODELS.max);
  expectEmbedding(calls[1]!, userKey, "BYOK otter");
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
