import { webhookCallback } from "grammy";
import { createBot } from "./bot";
import { botApi, logTelegramFailure } from "./botapi";
import { syncCommands } from "./botcommands";
import type { Env } from "./env";

let handler: ((req: Request) => Promise<Response>) | undefined;
let synced: Promise<unknown> | undefined;

export function handleBotWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
  if (env.TELEGRAM_MODE === "polling") return new Response("Webhook disabled", { status: 404 });
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  synced ??= syncCommands(env, botApi(env.BOT_TOKEN)).catch((error: unknown) => {
    synced = undefined;
    logTelegramFailure("command sync failed", error);
  });
  ctx.waitUntil(synced);
  // With onTimeout: "return", grammY attaches an unhandled finally() to the update.
  // A late rejection can then expose a raw BotError outside our catch below.
  handler ??= webhookCallback(createBot(env), "cloudflare-mod", { timeoutMilliseconds: 55_000, onTimeout: "throw" }) as unknown as NonNullable<typeof handler>;
  // grammY invokes bot.catch only in polling; webhook failures reject here.
  return handler(req).catch((error: unknown) => {
    logTelegramFailure("bot webhook failed", error);
    return new Response("Internal server error", { status: 500 });
  });
}
