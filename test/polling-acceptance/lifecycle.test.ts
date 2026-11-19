import { expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Env } from "../../src/env";
import { startPolling } from "../../src/runtime/polling";

test("shutdown aborts real grammY deleteWebhook retry before polling starts", async () => {
  const bot = new Bot("1:offline", { botInfo: {
    id: 1, is_bot: true, first_name: "Offline", username: "offline_bot",
  } as any });
  const retryEntered = Promise.withResolvers<void>();
  const calls: { method: string; payload: any }[] = [];
  let deletions = 0, aborted = false, syncs = 0;
  bot.api.config.use(async (_prev, method, payload, signal) => {
    calls.push({ method, payload });
    if (method === "getUpdates") return { ok: true, result: [] } as any;
    if (method !== "deleteWebhook") throw new Error(`Unexpected API method ${method}`);
    if (++deletions === 1) return { ok: false, error_code: 500, description: "offline startup failure" } as any;
    retryEntered.resolve();
    return await new Promise<never>((_resolve, reject) => {
      signal!.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("offline deletion aborted"));
      }, { once: true });
    });
  });
  const polling = startPolling({ TELEGRAM_MODE: "polling", BOT_TOKEN: "1:offline" } as Env, {
    createBot: () => bot as any,
    syncCommands: async () => { syncs++; return false; },
  });
  try {
    await retryEntered.promise;
    expect(bot.isRunning()).toBe(true);
    await polling.stop();
    expect(aborted).toBe(true);
    expect(bot.isRunning()).toBe(false);
    expect(syncs).toBe(0);
    expect(deletions).toBe(2);
    expect(calls.filter(c => c.method === "deleteWebhook").map(c => c.payload))
      .toEqual([{ drop_pending_updates: false }, { drop_pending_updates: false }]);
    // stop() performs only its final offset confirmation, never a long poll.
    expect(calls.filter(c => c.method === "getUpdates").map(c => c.payload))
      .toEqual([{ offset: 1, limit: 1 }]);
  } finally { await polling.stop(); }
}, 5000);
