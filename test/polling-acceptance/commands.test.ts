import { expect, mock, test } from "bun:test";
import { Bot } from "grammy";
import type { Ctx } from "../../src/bot";
import type { Env } from "../../src/env";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { registerCommands } = await import("../../src/commands");

for (const origin of ["http://localhost:3000", "https://bot.example"]) {
  for (const command of ["start", "mcp"]) {
    test(`/${command} actual Telegram payload supports ${origin}`, async () => {
      const bot = new Bot<Ctx>("1:offline", { botInfo: {
        id: 1, is_bot: true, first_name: "Offline", username: "offline_bot",
      } as any });
      const calls: { method: string; payload: any }[] = [];
      bot.api.config.use(async (_prev, method, payload) => {
        calls.push({ method, payload });
        // Exercise the real /start text fallback as well as the widget keyboard.
        if (String(method) === "sendWidget") return { ok: false, error_code: 400, description: "offline: widget unsupported" } as any;
        if (method === "sendMessage") return { ok: true, result: { message_id: 100 } } as any;
        throw new Error(`Unexpected API method ${method}`);
      });
      bot.use(async (ctx, next) => {
        ctx.lang = "en";
        ctx.user = { id: 10, role: "admin" } as Ctx["user"];
        await next();
      });
      registerCommands(bot, { PUBLIC_URL: origin } as Env);
      await bot.handleUpdate({ update_id: 1, message: {
        message_id: 1, date: 1, chat: { id: 10, type: "private", first_name: "Tester" },
        from: { id: 10, is_bot: false, first_name: "Tester", language_code: "en" },
        text: `/${command}`, entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
      } });
      expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
      if (command === "start") expect(calls.map(c => c.method)).toEqual(["sendWidget", "sendMessage"]);
      for (const { payload } of calls) {
        const rows = payload.reply_markup?.inline_keyboard ?? [];
        expect(rows.every((row: any[]) => row.length > 0)).toBe(true);
        const apps = rows.flat().filter((button: any) => button.web_app);
        if (origin.startsWith("http:")) expect(apps).toEqual([]);
        else expect(apps.map((button: any) => button.web_app.url)).toEqual([`${origin}/`]);
        if (command === "start") {
          expect(rows.flat().some((button: any) => button.callback_data === "help")).toBe(true);
          expect(rows.flat().some((button: any) => button.switch_inline_query_current_chat === "")).toBe(true);
        }
      }
    });
  }
}
