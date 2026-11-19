import { expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Env } from "../../src/env";
import { startPolling } from "../../src/runtime/polling";
import { syncCommands } from "../../src/botcommands";

const env = { TELEGRAM_MODE: "polling", BOT_TOKEN: "1:fake" } as Env;
const info = { id: 1, is_bot: true as const, first_name: "offline", username: "offline_bot" };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

test("one grammY poller deletes webhook without dropping pending, routes sequentially and stops", async () => {
  const bot = new Bot("1:fake", { botInfo: info as any });
  let starts = 0, syncs = 0;
  const calls: { method: string; payload: any }[] = [], seen: number[] = [];
  bot.use(async ctx => { seen.push(ctx.update.update_id); await Bun.sleep(5); seen.push(-ctx.update.update_id); });
  bot.api.config.use(async (_prev, method, payload, signal) => {
    calls.push({ method, payload });
    if (method === "deleteWebhook") return { ok: true, result: true } as any;
    if (method !== "getUpdates") throw new Error(`Unexpected API: ${method}`);
    if (calls.filter(c => c.method === "getUpdates").length === 1) return { ok: true, result: [{ update_id: 10 }, { update_id: 11 }] } as any;
    if ((payload as any).timeout) await new Promise<void>(resolve => {
      if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { ok: true, result: [] } as any;
  });
  const polling = startPolling(env, { createBot: () => { starts++; return bot as any; }, syncCommands: async () => { syncs++; return true; } });
  await until(() => seen.length === 4);
  await Promise.all([polling.stop(), polling.stop()]);
  expect(starts).toBe(1); expect(syncs).toBe(1);
  expect(seen).toEqual([10, -10, 11, -11]);
  expect(calls[0]).toEqual({ method: "deleteWebhook", payload: { drop_pending_updates: false } });
  expect(calls.at(-1)?.payload.offset).toBe(12);
  expect(bot.isRunning()).toBe(false);
});

test("webhook mode creates no polling bot or API calls", async () => {
  let created = false;
  await startPolling({ ...env, TELEGRAM_MODE: "webhook" }, { createBot: () => { created = true; throw new Error("must not create"); }, syncCommands }).stop();
  expect(created).toBe(false);
});

test("shutdown during getMe initialization aborts without starting polling", async () => {
  const bot = new Bot("1:fake");
  let methods: string[] = [];
  bot.api.config.use(async (_prev, method, _payload, signal) => {
    methods.push(method);
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("aborted");
  });
  const polling = startPolling(env, { createBot: () => bot as any, syncCommands });
  await until(() => methods.length > 0);
  await polling.stop();
  expect(methods).toEqual(["getMe"]);
});

test("start rejection is retried with the same bot and shutdown cancels backoff", async () => {
  let starts = 0, inited = 0;
  const bot = { api: { config: { use() {} } }, async init() { inited++; }, async start() { starts++; throw new Error("transient startup"); }, isRunning: () => false };
  const polling = startPolling(env, { createBot: () => bot as any, syncCommands });
  await until(() => starts === 2);
  await polling.stop();
  expect(inited).toBe(2);
  await Bun.sleep(20); expect(starts).toBe(2);
});

for (const origin of ["http://localhost:3000", "https://localhost", "https://bot.example"]) {
  test(`command menu supports ${origin}`, async () => {
    const methods: string[] = [], menus: any[] = [];
    const api = new Proxy({}, { get: (_target, method: string) => async (payload: any) => {
      methods.push(method); if (method === "setChatMenuButton") menus.push(payload.menu_button);
    } });
    const statement = { first: async () => null, all: async () => ({ results: [] }), bind() { return this; }, run: async () => {} };
    await syncCommands({ ...env, PUBLIC_URL: origin, DB: { prepare: () => statement } } as any, api as any);
    expect(menus[0].type).toBe(origin === "https://bot.example" ? "web_app" : "commands");
    expect(methods).toContain("setMyCommands");
  });
}

test("localhost search uploads local bytes without signed links or WebApp album buttons", async () => {
  // Delivery transitively imports the legacy Worker entrypoint; bundle with the
  // same cloudflare shim as the production Bun server, never mock Telegram HTTP.
  const result = await Bun.build({ entrypoints: ["src/search/deliver.ts"], target: "bun", outdir: ".tmp/polling-deliver", external: ["grammy", "@resvg/resvg-js"], plugins: [{ name: "worker-shim", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: `${process.cwd()}/src/runtime/worker-shim.ts` }));
  } }] });
  expect(result.success).toBe(true);
  const modulePath = `${process.cwd()}/.tmp/polling-deliver/deliver.js`;
  const { sendMeme, sendResults } = await import(modulePath);
  const { InputFile } = await import("grammy");
  const sent: any[] = [];
  const localEnv = { ...env, PUBLIC_URL: "http://localhost:3000", MEDIA: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, httpMetadata: { contentType: "image/jpeg" } }) }, DB: { prepare: () => ({ bind() { return this; }, run: async () => {}, all: async () => ({ results: [] }) }) } } as any;
  const api = { sendPhoto: async (_chat: number, file: unknown) => { sent.push(file); return {}; }, sendMessage: async () => { throw new Error("must not send local WebApp album link"); } } as any;
  const meme = { id: "local", kind: "photo", mime: "image/jpeg", file_id: "", r2_file: "local.jpg", porn: 0 } as any;
  await sendMeme(localEnv, api, 1, meme, {}, false);
  await sendResults(localEnv, api, 1, 1, [meme], "en");
  expect(sent.length).toBe(2);
  expect(sent.every(file => file instanceof InputFile)).toBe(true);
});
