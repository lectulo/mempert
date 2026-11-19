import { Api } from "grammy";
import { telegramClientOptions } from "../telegramproxy";
import type { createBot } from "../bot";
import type { syncCommands } from "../botcommands";
import type { Env } from "../env";

const allowedUpdates = ["message", "inline_query", "chosen_inline_result", "callback_query", "pre_checkout_query", "subscription", "my_chat_member", "widget_query"];
// Transport errors can contain token-bearing URLs. Never log the raw error object.
function logFailure(context: string, error: unknown) {
  const code = (error as { error_code?: unknown } | null)?.error_code;
  console.error(context, typeof code === "number" ? `Telegram error ${code}` : "Telegram transport or handler error");
}

/** One supervised grammY loop. Reuse the bot so its update offset survives retries. */
export function startPolling(env: Env, dependencies: { createBot: typeof createBot; syncCommands: typeof syncCommands }) {
  if (env.TELEGRAM_MODE !== "polling") return { stop: async () => {} };
  const bot = dependencies.createBot(env), abort = new AbortController();
  // grammY's Node typings use abort-controller; Bun's native signals implement
  // the same runtime interface but differ in DOM event typing.
  type TelegramSignal = NonNullable<Parameters<typeof bot.init>[0]>;
  // grammY's stop() also confirms the offset with a final, non-long-poll request.
  // Bound that request even if Telegram is unreachable during shutdown.
  bot.api.config.use((prev, method, payload, signal) => prev(method, payload,
    signal ?? (abort.signal.aborted ? AbortSignal.timeout(10_000) as unknown as TelegramSignal : undefined)));
  const commandApi = new Api(env.BOT_TOKEN, telegramClientOptions(env.OUTBOUND_PROXY_URL));
  commandApi.config.use((prev, method, payload) => prev(method, payload, abort.signal as unknown as TelegramSignal));
  let commands: Promise<unknown> | undefined;
  let wake: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const done = (async () => {
    let delay = 1000;
    while (!abort.signal.aborted) {
      try {
        // init() inside grammY start() can race stop() before its abort controller exists.
        // Initialize explicitly with our own signal before entering start().
        await bot.init(abort.signal as unknown as TelegramSignal);
        if (abort.signal.aborted) break;
        await bot.start({ drop_pending_updates: false, allowed_updates: allowedUpdates as NonNullable<Parameters<typeof bot.start>[0]>["allowed_updates"], onStart() {
          delay = 1000;
          commands ??= dependencies.syncCommands(env, commandApi).catch(e => {
            if (!abort.signal.aborted) logFailure("command sync failed", e);
            commands = undefined;
          });
        } });
      } catch (e) {
        if (!abort.signal.aborted) logFailure("Telegram polling failed; retrying", e);
      }
      if (abort.signal.aborted) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
      delay = Math.min(delay * 2, 30_000);
    }
  })();
  return { stop(): Promise<void> {
    return stopping ??= (async () => {
      abort.abort(); wake?.();
      // Do not await start() first: it resolves only after stop() cancels polling.
      if (bot.isRunning()) await bot.stop().catch(e => logFailure("Telegram polling stop failed", e));
      await done;
      await commands;
    })();
  } };
}
