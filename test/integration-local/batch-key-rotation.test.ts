import { expect, mock, spyOn, test } from "bun:test";
import { Api } from "grammy";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { OPENROUTER_BATCH_KEY_IN_USE, saveAIConfig } from "../../src/aimodels";
import { getBatch, openRouterKey } from "../../src/openrouter";
import { createSession } from "../../src/session";
import { setUserKey } from "../../src/userkey";
import { createCompatibleProvider, fixture, providerKey } from "./fixture";

const { submitImport } = await import("../../src/batch");
const { handleApp } = await import("../../src/webapp");
const baseUrl = "https://openrouter.ai/api/v1";
const provider = { action: "provider", id: "openrouter", name: "OpenRouter", baseUrl };

test("DB and admin API block shared key changes until accepted batches are processed", async () => {
  const f = await fixture();
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(input)).toBe(`${baseUrl}/batches/legacy-remote`);
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer fixture-original-key");
    return Response.json({ id: "legacy-remote", status: "in_progress" });
  }, { preconnect: fetch.preconnect }));
  try {
    await f.env.DB.exec("INSERT INTO users(id,role) VALUES(1,'admin');");
    const headers = { Cookie: `session=${await createSession(f.env, 1)}`, "Content-Type": "application/json" };
    const save = async (data: { key?: string | null; name?: string }) => (await handleApp(new Request(`${f.env.PUBLIC_URL}/app/api/admin/ai`, {
      method: "POST", headers, body: JSON.stringify({ ...provider, ...data }),
    }), f.env, {} as ExecutionContext))!;
    await f.env.DB.exec("INSERT INTO imports(id,user_id,status,batch_id) VALUES('legacy',1,'submitted','legacy-remote');");
    // Upgraded installs can enter the original shared key to recover legacy batches.
    expect((await save({ key: "fixture-original-key" })).status).toBe(200);
    // Pre-migration batches with an unspecified key source still block rotation.
    expect((await save({ key: "fixture-replacement" })).status).toBe(409);
    expect((await save({ key: null })).status).toBe(409);
    expect(await getBatch(f.env, 1, "global", "legacy-remote")).toMatchObject({ id: "legacy-remote" });
    await f.env.DB.exec("UPDATE imports SET status='done' WHERE id='legacy';");
    expect((await save({ key: "fixture-replacement" })).status).toBe(200);

    await f.env.DB.exec("INSERT INTO imports(id,user_id,status,batch_id,key_source) VALUES('global',1,'submitted','global-remote','global');");
    expect(() => f.db.sqlite.exec("UPDATE ai_providers SET sealed_key = NULL WHERE id='openrouter'")).toThrow("openrouter_batch_key_in_use");
    const blocked = await save({ key: "new-fixture-key" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json<{ error: string }>()).toEqual({ error: OPENROUTER_BATCH_KEY_IN_USE });
    expect((await save({ key: null })).status).toBe(409);
    expect((await save({ name: "Renamed", key: "" })).status).toBe(200);
    expect(await openRouterKey(f.env)).toBe("fixture-replacement");
    await createCompatibleProvider(f.env, "fixture-compatible", "https://batch-fixture.example/v1", "fixture-compatible-key");
    await f.env.DB.exec("UPDATE imports SET status='processing' WHERE id='global';");
    expect((await save({ key: null })).status).toBe(409);

    await f.env.DB.exec(`UPDATE imports SET status='done' WHERE id='global';
      INSERT INTO imports(id,user_id,status,batch_id,key_source) VALUES('personal',1,'submitted','user-remote','user');
      INSERT INTO imports(id,user_id,status) VALUES('queued',1,'submitting');`);
    expect((await save({ key: null })).status).toBe(200);
    await expect(openRouterKey(f.env)).rejects.toThrow("OpenRouter provider credentials are not configured");
  } finally { network.mockRestore(); f.close(); }
});

test("submission keeps its credential stable from the POST through acceptance", async () => {
  const f = await fixture();
  const telegram = spyOn(Api.prototype, "sendMessage").mockResolvedValue({ message_id: 1 } as never);
  const attempts: { url: string; authorization: string | null; rotation: string | null }[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url !== `${baseUrl}/batches` || init?.method !== "POST") throw new Error(`Unexpected request: ${url}`);
    const rotation = await saveAIConfig(f.env, { ...provider, key: "would-strand-batch" });
    attempts.push({ url, authorization: (init.headers as Record<string, string>).Authorization, rotation });
    return Response.json({ id: "remote-batch", status: "validating" });
  }, { preconnect: fetch.preconnect }));
  try {
    await f.meme("photo", 101);
    await f.env.DB.exec(`INSERT INTO imports(id,user_id,status) VALUES('queued',101,'submitting');
      UPDATE memes SET status='describing',title=NULL,import_id='queued' WHERE id='photo';`);
    await expect(submitImport(f.env, "queued")).rejects.toThrow("OpenRouter provider credentials are not configured");
    expect(await f.env.DB.prepare("SELECT status,submission_started FROM imports WHERE id='queued'").first<Record<string, unknown>>())
      .toEqual({ status: "submitting", submission_started: 0 });
    expect(attempts).toEqual([]);

    await providerKey(f.env, "openrouter", "submit-key");
    const claimsAtKeyLookup: unknown[] = [];
    const prepare = f.db.prepare.bind(f.db);
    const trackKeyLookup = spyOn(f.db, "prepare").mockImplementation((sql) => {
      if (sql.includes("FROM ai_providers p WHERE p.id = ?")) {
        claimsAtKeyLookup.push(f.db.sqlite.query("SELECT submission_started FROM imports WHERE id='queued'").get());
      }
      return prepare(sql);
    });
    try { await submitImport(f.env, "queued"); }
    finally { trackKeyLookup.mockRestore(); }
    expect(claimsAtKeyLookup).toEqual([{ submission_started: 1 }]);
    expect(attempts).toEqual([{ url: `${baseUrl}/batches`, authorization: "Bearer submit-key", rotation: OPENROUTER_BATCH_KEY_IN_USE }]);
    expect(await f.env.DB.prepare("SELECT status,batch_id,key_source FROM imports WHERE id='queued'").first<Record<string, unknown>>())
      .toEqual({ status: "submitted", batch_id: "remote-batch", key_source: "global" });
    expect(await saveAIConfig(f.env, { ...provider, key: "after-submit" })).toBe(OPENROUTER_BATCH_KEY_IN_USE);
  } finally { network.mockRestore(); telegram.mockRestore(); f.close(); }
});

test("legacy user-batch polls never fall back to the shared payer", async () => {
  const f = await fixture();
  const requests: (string | null)[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== `${baseUrl}/batches/legacy-id`) throw new Error(`Unexpected request: ${input}`);
    requests.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? null);
    return Response.json({ id: "legacy-id", status: "in_progress" });
  }, { preconnect: fetch.preconnect }));
  try {
    await providerKey(f.env, "openrouter", "shared-fixture-key");
    await f.env.DB.exec("INSERT INTO users(id,role) VALUES(42,'paid');");
    await expect(getBatch(f.env, 42, "user", "legacy-id")).rejects.toThrow("OpenRouter batch credentials are unavailable");
    expect(requests).toEqual([]);
    await setUserKey(f.env, 42, "legacy-fixture-key");
    expect(await getBatch(f.env, 42, "user", "legacy-id")).toMatchObject({ id: "legacy-id" });
    await setUserKey(f.env, 42, null);
    await expect(getBatch(f.env, 42, "user", "legacy-id")).rejects.toThrow("OpenRouter batch credentials are unavailable");
    expect(requests).toEqual(["Bearer legacy-fixture-key"]);
  } finally { network.mockRestore(); f.close(); }
});
