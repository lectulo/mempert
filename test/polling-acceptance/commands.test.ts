import { expect, mock, test } from "bun:test";
import { Bot } from "grammy";
import type { Ctx } from "../../src/bot";
import type { Env } from "../../src/env";
import { t } from "../../src/i18n";

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

for (const lang of ["en", "ru"] as const) {
  test(`disabled batch blocks provider commands but keeps Telegram ZIP import (${lang})`, async () => {
    const bot = new Bot<Ctx>("1:offline", { botInfo: {
      id: 1, is_bot: true, first_name: "Offline", username: "offline_bot",
    } as any });
    const messages: { text: string; reply_markup?: { inline_keyboard: { text: string; url: string }[][] } }[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "answerCallbackQuery") return { ok: true, result: true } as any;
      if (method !== "sendMessage") throw new Error(`Unexpected API method ${method}`);
      messages.push(payload as (typeof messages)[number]);
      return { ok: true, result: { message_id: 100 } } as any;
    });
    bot.use(async (ctx, next) => {
      ctx.lang = lang;
      ctx.user = { id: 10, role: "admin", describe_tier: "medium" } as Ctx["user"];
      await next();
    });
    // Only ZIP may reach the database; the provider batch commands must return before any side effects.
    const writes: { sql: string; args: unknown[] }[] = [];
    const DB = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { writes.push({ sql, args }); } }) }) };
    registerCommands(bot, { BATCH_ENABLED: "false", PUBLIC_URL: "https://bot.example", ENCRYPTION_KEY: "test-key", DB } as unknown as Env);
    const from = { id: 10, is_bot: false, first_name: "Tester", language_code: lang };
    const chat = { id: 10, type: "private", first_name: "Tester" } as const;
    const commands = ["batch", "batch_finish", "batch_cancel", "batch_status", "batch_retry"];
    for (const [index, command] of [...commands, "help", "about"].entries()) {
      await bot.handleUpdate({ update_id: index + 1, message: {
        message_id: index + 1, date: 1, chat, from,
        text: `/${command}`, entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
      } });
    }
    await bot.handleUpdate({ update_id: 10, callback_query: {
      id: "old-help-button", from, chat_instance: "offline", data: "help",
      message: { message_id: 1, date: 1, chat, text: "Start" },
    } });
    expect(messages.slice(0, commands.length).map(({ text }) => text)).toEqual(commands.map(() => t(lang, "batch_disabled")));
    expect(messages).toHaveLength(commands.length + 3);
    expect(messages[commands.length].text).toContain("/grant");
    expect(messages[commands.length].text).toContain("/batch_zip —");
    expect(messages[commands.length + 2].text).toContain("/batch_zip —");
    for (const { text } of messages.slice(commands.length)) {
      expect(text).not.toMatch(/\/batch\b|\/batch_(finish|cancel|status|retry)\b/);
      expect(text).toContain("/settings");
    }
    expect(writes).toEqual([]);

    await bot.handleUpdate({ update_id: 11, message: {
      message_id: 2, date: 1, chat, from,
      text: "/batch_zip", entities: [{ type: "bot_command", offset: 0, length: "/batch_zip".length }],
    } });
    const [created, status] = writes;
    expect(writes).toHaveLength(2);
    expect(created.sql).toMatch(/^INSERT INTO zip_imports/);
    expect(status.sql).toMatch(/^UPDATE zip_imports SET status_msg_id/);
    expect(status.args).toEqual([100, created.args[0]]);
    expect(messages.at(-1)).toMatchObject({
      text: t(lang, "zip_link_regular"),
      reply_markup: { inline_keyboard: [[{ text: t(lang, "zip_button"), url: expect.stringContaining(`https://bot.example/upload/${created.args[0]}?`) }]] },
    });
  });
}
