import { expect, mock, test } from "bun:test";
import { Bot } from "grammy";
import type { Env } from "../../src/env";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { startPolling } = await import("../../src/runtime/polling");
const env = { TELEGRAM_MODE: "polling", BOT_TOKEN: "1:offline" } as Env;
const deferred = () => Promise.withResolvers<void>();
const me = { id: 1, is_bot: true, first_name: "Offline", username: "offline_bot" };

// No global fetch replacement: intercept the real grammY API pipeline before transport.
test("real grammY preserves pending updates, processes sequentially, advances offset and aborts long polling", async () => {
  const bot = new Bot("1:offline");
  const entered = deferred(), release = deferred(), longPoll = deferred();
  const events: string[] = [], requests: { method: string; payload: any }[] = [];
  let gets = 0, aborted = false;
  bot.api.config.use(async (_prev, method, payload, signal) => {
    requests.push({ method, payload });
    if (method === "getMe") return { ok: true, result: me } as any;
    if (method === "deleteWebhook") return { ok: true, result: true } as any;
    if (method !== "getUpdates") throw new Error(`Unexpected API method ${method}`);
    if (!(payload as any).timeout) return { ok: true, result: [] } as any;
    if (++gets === 1) return { ok: true, result: [{ update_id: 40 }, { update_id: 41 }] } as any;
    longPoll.resolve();
    return await new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => {
      aborted = true; reject(new Error("offline request aborted"));
    }, { once: true }));
  });
  bot.use(async ctx => {
    events.push(`start:${ctx.update.update_id}`);
    if (ctx.update.update_id === 40) { entered.resolve(); await release.promise; }
    events.push(`done:${ctx.update.update_id}`);
  });
  const polling = startPolling(env, { createBot: () => bot as any, syncCommands: async () => false });
  try {
    await entered.promise;
    expect(events).toEqual(["start:40"]);
    expect(gets).toBe(1);
    release.resolve(); await longPoll.promise;
    expect(events).toEqual(["start:40", "done:40", "start:41", "done:41"]);
    const polls = requests.filter(r => r.method === "getUpdates");
    expect(polls[1].payload.offset).toBe(42);
    expect(requests.find(r => r.method === "deleteWebhook")!.payload.drop_pending_updates).toBe(false);
    await polling.stop();
    expect(aborted).toBe(true);
    expect(requests.at(-1)!.payload.offset).toBe(42);
  } finally { release.resolve(); await polling.stop(); }
}, 5000);

test("real grammY loop restarts after getUpdates conflict without resetting processed offset", async () => {
  const bot = new Bot("1:offline"), resumed = deferred();
  let deletions = 0, gets = 0;
  const offsets: number[] = [];
  bot.use(async () => {});
  bot.api.config.use(async (_prev, method, payload, signal) => {
    if (method === "getMe") return { ok: true, result: me } as any;
    if (method === "deleteWebhook") { deletions++; return { ok: true, result: true } as any; }
    if (method !== "getUpdates") throw new Error(`Unexpected API method ${method}`);
    if (!(payload as any).timeout) return { ok: true, result: [] } as any;
    offsets.push((payload as any).offset);
    if (++gets === 1) return { ok: true, result: [{ update_id: 70 }] } as any;
    if (gets === 2) return { ok: false, error_code: 409, description: "offline injected conflict" } as any;
    resumed.resolve();
    return await new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const polling = startPolling(env, { createBot: () => bot as any, syncCommands: async () => false });
  try {
    await resumed.promise;
    expect(deletions).toBe(2);
    expect(offsets.slice(-2)).toEqual([71, 71]);
  } finally { await polling.stop(); }
}, 5000);
