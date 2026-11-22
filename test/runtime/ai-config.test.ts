import { expect, mock, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { createHmac } from "node:crypto";
import { AI_WORKLOADS, getAIProvider, resolveAI, saveAIConfig, type AIWorkload } from "../../src/aimodels";
import { DESCRIBE_FALLBACKS, DESCRIBE_UNCENSORED, DESCRIBE_VIDEO_FALLBACKS, MODELS } from "../../src/config";
import type { Env } from "../../src/env";
import { createDatabase } from "../../src/runtime/db";
import { createSession } from "../../src/session";
import { createToken } from "../../src/tokens";

const { handleApp } = await import("../../src/webapp");

const origin = "https://app.example";
const baseUrl = "https://fixture-provider.example/v1";
const providerId = "fixture-provider";
const provider = { action: "provider", id: providerId, name: "Fixture Provider", baseUrl };
const model = { providerId, model: "fixture-chat", prompt: 1.25, completion: 4, cacheWrite: 2, cacheRead: 0.3 };
const openrouter = { action: "provider", id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" };
const botToken = "1:fixture";

function miniAppAuth() {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 1, first_name: "Admin" }) });
  const check = [...params].map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return `tma ${params}`;
}

async function fixture() {
  const db = createDatabase(":memory:", `${import.meta.dir}/../../migrations`);
  db.sqlite.exec("INSERT INTO users (id, role) VALUES (1, 'admin'), (2, 'paid')");
  const env = { DB: db, PUBLIC_URL: origin, ENCRYPTION_KEY: "fixture-only", BOT_TOKEN: botToken } as unknown as Env;
  const adminCookie = `session=${await createSession(env, 1)}`;
  return {
    env, db, adminCookie,
    async request(body?: unknown, headers: Record<string, string> = { Cookie: adminCookie }) {
      const req = new Request(`${origin}/app/api/admin/ai`, body === undefined ? { headers } : {
        method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
      });
      return (await handleApp(req, env, {} as ExecutionContext))!;
    },
  };
}

test("a clean install seeds the exact upstream OpenRouter routes without credentials", async () => {
  const f = await fixture();
  try {
    // Upstream d039880 used the same search model for rewrite, agent, labels, facts, and moods.
    const searchModel = "deepseek/deepseek-v4.1-flash-1017";
    const defaults = {
      photo_medium: "openai/gpt-6-luna",
      photo_max: "google/gemini-4-argon",
      video: "google/gemini-3.8-flash",
      search_rewrite: searchModel,
      search_agent: searchModel,
      analysis_labels: searchModel,
      pair_facts: searchModel,
      analysis_moods: searchModel,
      pair_moods: searchModel,
    } satisfies Record<AIWorkload, string>;
    const expectedRoute = (workload: AIWorkload) => ({ providerId: "openrouter", model: defaults[workload] });
    const res = await f.request();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { providers, routes, models } = await res.json<any>();
    expect(providers).toEqual([
      { id: "openrouter", name: "OpenRouter", baseUrl: openrouter.baseUrl, hasKey: false, keyPreview: null },
    ]);
    expect(routes).toEqual(Object.fromEntries(Object.entries(defaults).map(([workload, model]) => [workload, { providerId: "openrouter", model }])));
    expect([...new Set(models.map((m: { providerId: string }) => m.providerId))]).toEqual(["openrouter"]);
    for (const workload of AI_WORKLOADS) expect(await resolveAI(f.env, workload)).toBeNull();
    const key = "fixture-or-key";
    expect(await saveAIConfig(f.env, { ...openrouter, key })).toBeNull();
    for (const workload of AI_WORKLOADS) {
      expect(await resolveAI(f.env, workload)).toMatchObject({ ...expectedRoute(workload), baseUrl: openrouter.baseUrl, key });
    }
    expect(await (await f.request()).text()).not.toContain(key);
  } finally { f.db.close(); }
});

test("admin can rotate encrypted keys and update models and routes", async () => {
  const f = await fixture();
  try {
    expect((await f.request({ ...provider, action: "provider_create", key: "initial-fixture-key" })).status).toBe(200);
    const key = "fixture-provider-key";
    const save = await f.request({ ...provider, key });
    expect(await save.json<{ ok: boolean }>()).toEqual({ ok: true });
    const stored = await f.db.prepare("SELECT sealed_key FROM ai_providers WHERE id = ?").bind(providerId).first<string>("sealed_key");
    expect(stored).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(stored).not.toContain(key);
    expect(await getAIProvider(f.env, providerId)).toEqual({ providerId, baseUrl, key });
    const name = "Renamed Fixture Provider";
    expect((await f.request({ ...provider, name, key: "" })).status).toBe(200);
    const get = await (await f.request()).text();
    expect(get).not.toContain(key);
    expect(get).not.toContain(stored!);
    expect(JSON.parse(get).providers).toContainEqual({ id: providerId, name, baseUrl, hasKey: true, keyPreview: "fi••••ey" });

    expect((await f.request({ action: "model", ...model })).status).toBe(200);
    expect((await f.request({ action: "route", workload: "search_agent", providerId, model: model.model })).status).toBe(200);
    expect(await resolveAI(f.env, "search_agent")).toEqual({ ...model, baseUrl, key });
    expect((await f.request({ ...provider, key: "rotated-fixture-key" })).status).toBe(200);
    expect(await resolveAI(f.env, "search_agent")).toMatchObject({ key: "rotated-fixture-key" });
    expect((await f.request({ ...provider, key: null })).status).toBe(200);
    expect(await resolveAI(f.env, "search_agent")).toBeNull();
    expect((await f.request({ ...openrouter, key: "fixture-or-key" })).status).toBe(200);
    expect(await getAIProvider(f.env, "openrouter")).toMatchObject({ key: "fixture-or-key" });
    expect((await f.request({ ...openrouter, key: null })).status).toBe(200);
    expect(await getAIProvider(f.env, "openrouter")).toBeNull();
  } finally { f.db.close(); }
});

test("AI configuration requires interactive admin auth and rejects invalid destinations, prices and routes", async () => {
  const f = await fixture();
  try {
    expect(await saveAIConfig(f.env, { ...provider, action: "provider_create", key: "fixture-key" })).toBeNull();
    expect(await saveAIConfig(f.env, { action: "model", ...model })).toBeNull();
    const token = (await createToken(f.db, 1, "fixture", true))!.token;
    const bearer = { Authorization: `Bearer ${token}`, Cookie: f.adminCookie };
    expect((await f.request(undefined, bearer)).status).toBe(403);
    expect((await f.request(provider, bearer)).status).toBe(403);
    expect((await f.request(undefined, { Cookie: `session=${await createSession(f.env, 2)}` })).status).toBe(403);
    const miniApp = { Authorization: miniAppAuth(), Origin: origin };
    expect((await f.request(provider, miniApp)).status).toBe(200);
    expect(await (await f.request(undefined, miniApp)).text()).toContain("fi••••ey");
    const me = await handleApp(new Request(`${origin}/app/api/me`, { headers: { Cookie: f.adminCookie } }), f.env, {} as ExecutionContext);
    expect(me?.status).toBe(200);
    const account = await me!.text();
    expect(account).toContain("photo_medium");
    expect(account).not.toContain("keyPreview");
    expect(account).not.toContain("fi••••ey");
    expect((await f.request(provider, { Cookie: f.adminCookie, Origin: "https://other.example" })).status).toBe(403);
    expect((await f.request(provider, { Cookie: f.adminCookie, "Content-Type": "text/plain" })).status).toBe(415);

    for (const body of [null, { ...provider, baseUrl: "https://other.example/v1" }, { ...provider, baseUrl: `${baseUrl}?q=secret` },
      { ...provider, id: "untrusted" }, { ...provider, key: "line\nbreak" },
      { action: "route", providerId, model: "missing", workload: "video" },
      { action: "route", providerId, model: model.model, workload: "embed" },
      { action: "route", providerId, model: model.model, workload: "video", key: "never echoed" },
      { action: "model", ...model, prompt: -1 },
    ]) {
      const res = await f.request(body);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("secret");
    }
    f.db.sqlite.exec("CREATE TRIGGER broken_provider_write BEFORE UPDATE ON ai_providers BEGIN SELECT RAISE(ABORT, 'private database error'); END");
    const failed = await f.request({ ...provider, key: "not-for-errors" });
    expect(failed.status).toBe(500);
    expect(await failed.json<{ error: string }>()).toEqual({ error: "AI configuration unavailable" });
    f.db.sqlite.exec("DROP TRIGGER broken_provider_write");
    expect(await saveAIConfig(f.env, { ...openrouter, key: "fixture-or-key" })).toBeNull();
    f.db.sqlite.exec("UPDATE ai_providers SET base_url = 'https://other.example/v1' WHERE id = 'openrouter'");
    expect(await getAIProvider(f.env, "openrouter")).toBeNull();
    expect(await resolveAI(f.env, "video")).toBeNull();
  } finally { f.db.close(); }
});

test("admins can add arbitrary compatible providers, but cannot change their destinations or read their full keys", async () => {
  const f = await fixture();
  try {
    const id = "another-provider_1";
    const destination = "https://compatible.example:8443/custom/v1";
    const key = "fixture-custom-key";
    const create = { action: "provider_create", id, name: "Another Provider", baseUrl: `${destination}/`, key };
    expect((await f.request(create, { Cookie: `session=${await createSession(f.env, 2)}` })).status).toBe(403);
    for (const bad of [
      { id: "openrouter" }, { id: "Invalid id" }, { key: "" },
      ...["http://compatible.example/v1", "https://localhost/v1", "https://service.internal/v1",
        "https://127.1/v1", "https://2852039166/v1", "https://168.63.129.16/v1", "https://[::ffff:127.0.0.1]/v1",
        "https://user@compatible.example/v1", "https://compatible.example/v1?#"].map((baseUrl) => ({ baseUrl })),
    ]) expect((await f.request({ ...create, ...bad })).status).toBe(400);
    expect((await f.request(create)).status).toBe(200);
    expect((await f.request({ ...create, baseUrl: "https://different.example/v1", key: "not-applied" })).status).toBe(400);

    const edit = { action: "provider", id, name: "Renamed Compatible API" };
    expect((await f.request({ ...edit, baseUrl: "https://different.example/v1", key: "not-applied" })).status).toBe(400);
    expect((await f.request({ ...edit, baseUrl: `${destination}/v2`, key: "not-applied" })).status).toBe(400);
    expect((await f.request(edit)).status).toBe(200);
    const sealed = await f.db.prepare("SELECT sealed_key FROM ai_providers WHERE id = ?").bind(id).first<string>("sealed_key");
    expect(sealed).not.toContain(key);
    const config = await (await f.request()).text();
    expect(config).not.toContain(key);
    expect(config).not.toContain(sealed!);
    expect(JSON.parse(config).providers).toContainEqual({ id, name: edit.name, baseUrl: destination, hasKey: true, keyPreview: "fi••••ey" });

    const model = { providerId: id, model: "vendor/chat-v2", prompt: 1, completion: 2, cacheWrite: 0, cacheRead: 0 };
    expect((await f.request({ action: "model", ...model })).status).toBe(200);
    expect((await f.request({ action: "route", workload: "search_agent", providerId: id, model: model.model })).status).toBe(200);
    expect(await resolveAI(f.env, "search_agent")).toEqual({ ...model, baseUrl: destination, key });
    await f.db.prepare("UPDATE ai_providers SET base_url = 'https://different.example/v1' WHERE id = ?").bind(id).run();
    await expect(resolveAI(f.env, "search_agent")).rejects.toThrow("AI provider key unavailable");
  } finally { f.db.close(); }
});

test("AI admin masks short and unreadable keys without disrupting the config", async () => {
  const f = await fixture();
  try {
    for (const [key, keyPreview] of [["Q", "••••"], ["QRST", "••••"], ["QRSTU", "QR••••TU"], [null, null]]) {
      expect(await saveAIConfig(f.env, { ...openrouter, key })).toBeNull();
      const res = await f.request();
      expect(res.status).toBe(200);
      expect((await res.json<any>()).providers[0]).toMatchObject({ hasKey: key !== null, keyPreview });
    }
    const cipher = "invalid-legacy-cipher";
    await f.db.prepare("UPDATE ai_providers SET sealed_key = ? WHERE id = ?").bind(cipher, openrouter.id).run();
    const res = await f.request();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(cipher);
    expect(JSON.parse(text).providers[0]).toMatchObject({ hasKey: true, keyPreview: "••••" });
  } finally { f.db.close(); }
});

test("AI admin can delete unused models and providers without changing historical spend", async () => {
  const f = await fixture();
  try {
    const spare = { ...model, model: "fixture-spare" };
    const deleteModel = { action: "deleteModel", providerId, model: model.model };
    const deleteProvider = { action: "deleteProvider", id: providerId };
    expect((await f.request({ ...provider, action: "provider_create", key: "fixture-key" })).status).toBe(200);
    for (const row of [model, spare]) expect((await f.request({ action: "model", ...row })).status).toBe(200);
    await f.db.prepare("INSERT INTO transactions (user_id, kind, model, key_source, cost) VALUES (2, 'describe', ?, 'global', 0.25)")
      .bind(model.model).run();
    const history = await f.db.prepare("SELECT * FROM transactions").all();
    const route = { action: "route", workload: "video", providerId, model: model.model };
    expect((await f.request(route)).status).toBe(200);
    for (const action of [deleteModel, deleteProvider]) {
      const res = await f.request(action);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("Reassign active workload routes");
    }
    // Unused siblings must survive a failed provider deletion. The DB also rejects bypassing the route checks.
    const models = () => f.db.prepare("SELECT model FROM ai_models WHERE provider_id = ? ORDER BY model").bind(providerId).all();
    expect((await models()).results).toEqual([{ model: model.model }, { model: spare.model }]);
    await expect(f.db.prepare("DELETE FROM ai_models WHERE provider_id = ? AND model = ?").bind(providerId, model.model).run())
      .rejects.toThrow("FOREIGN KEY constraint failed");
    await expect(f.db.prepare("DELETE FROM ai_providers WHERE id = ?").bind(providerId).run()).rejects.toThrow("FOREIGN KEY constraint failed");

    expect((await f.request({ ...route, providerId: openrouter.id, model: MODELS.describeVideo })).status).toBe(200);
    expect((await f.request(deleteModel)).status).toBe(200);
    expect((await models()).results).toEqual([{ model: spare.model }]);

    f.db.sqlite.exec("CREATE TRIGGER broken_provider_delete BEFORE DELETE ON ai_providers BEGIN SELECT RAISE(ABORT, 'private database error'); END");
    const failed = await f.request(deleteProvider);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private database error");
    expect((await models()).results).toEqual([{ model: spare.model }]);
    f.db.sqlite.exec("DROP TRIGGER broken_provider_delete");

    expect((await f.request(deleteProvider)).status).toBe(200);
    expect((await models()).results).toEqual([]);
    expect(await getAIProvider(f.env, providerId)).toBeNull();
    expect((await f.request(route)).status).toBe(400);
    expect((await f.db.prepare("SELECT * FROM transactions").all()).results).toEqual(history.results);
  } finally { f.db.close(); }
});

test("AI admin cannot delete fixed OpenRouter dependencies even when unrouted", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("DELETE FROM ai_routes").run();
    const res = await f.request({ action: "deleteProvider", id: openrouter.id });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("required for embeddings and batches");
    const fallbacks = [...new Set([...DESCRIBE_FALLBACKS, ...DESCRIBE_VIDEO_FALLBACKS, DESCRIBE_UNCENSORED])];
    const { models } = await (await f.request()).json<any>();
    for (const name of fallbacks) {
      expect(models).toContainEqual(expect.objectContaining({ providerId: openrouter.id, model: name, deleteProtected: true }));
      const result = await f.request({ action: "deleteModel", providerId: openrouter.id, model: name });
      expect(result.status).toBe(409);
      expect(await result.text()).toContain("built-in description fallback");
    }
    expect((await f.request({ action: "deleteModel", providerId: openrouter.id, model: MODELS.describeVideo })).status).toBe(200);
    expect((await f.request({ ...provider, action: "provider_create", key: "fixture-key" })).status).toBe(200);
    expect((await f.request({ ...model, action: "model", model: DESCRIBE_UNCENSORED })).status).toBe(200);
    expect((await f.request({ action: "deleteModel", providerId, model: DESCRIBE_UNCENSORED })).status).toBe(200);
  } finally { f.db.close(); }
});
