import { expect, mock, spyOn, test } from "bun:test";
import { Api, BotError, GrammyError, HttpError } from "grammy";
import type { InlineQueryResult, Update, UserFromGetMe } from "grammy/types";
import { createSession } from "../../src/session";
import { fixture } from "./fixture";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
const { createBot } = await import("../../src/bot");
const { handleApp } = await import("../../src/webapp");
const { handleBotWebhook } = await import("../../src/botwebhook");

const me: UserFromGetMe = {
  id: 1, is_bot: true, first_name: "Offline", username: "offline_bot",
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};
const update: Update = {
  update_id: 40,
  inline_query: { id: "private-inline-id", from: { id: 101, is_bot: false, first_name: "Private Name" }, query: "", offset: "", chat_type: "sender" },
};

function rejectedResult(method: string, results: readonly InlineQueryResult[]) {
  const result = results[0];
  if (result?.type !== "photo" || !("photo_url" in result)) throw new Error("expected a signed photo result");
  expect(new URL(result.photo_url).searchParams.has("s")).toBe(true);
  return new GrammyError("Telegram rejected private content", {
    ok: false, error_code: 400, description: `Unable to fetch ${result.photo_url}`,
  }, method, { results, privateText: "private input" });
}

test("bot.catch logs only safe categories for inline API, transport and handler failures", async () => {
  const f = await fixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await f.meme("polling-photo", 101);
    const bot = createBot(f.env);
    bot.botInfo = me;
    const transport = new HttpError("private bot-token URL", new Error("private transport cause"));
    const unexpected = Object.assign(new Error("private handler error"), { error_code: "private fake code" });
    let apiError: GrammyError | undefined;
    let failure: unknown;
    bot.api.config.use(async (_prev, method, payload) => {
      if (method !== "answerInlineQuery") throw new Error("unexpected Telegram method");
      apiError = rejectedResult(method, (payload as { results: InlineQueryResult[] }).results);
      throw failure ?? apiError;
    });
    f.env.UPLOADS.send = async () => { throw new Error("private enqueue failure"); };
    for (const error of [undefined, transport, unexpected]) {
      failure = error;
      const wrapped = await bot.handleUpdate(update).catch((e: unknown) => e);
      if (!(wrapped instanceof BotError)) throw new Error("expected grammY to wrap the failure");
      expect(wrapped.error).toBe(failure ?? apiError);
      await bot.errorHandler(wrapped);
    }
    expect(log.mock.calls).toEqual([
      ["bot update failed", "Telegram API error", 400],
      ["bot update failed", "Telegram transport error"],
      ["bot update failed", "unexpected error"],
    ]);
    expect(warn.mock.calls).toEqual(Array.from({ length: 3 }, () => ["inline upload enqueue failed"]));
  } finally { warn.mockRestore(); log.mockRestore(); f.close(); }
});

test("prepared-share failures never log signed results or count a failed share", async () => {
  const f = await fixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  const send = spyOn(Api.prototype, "savePreparedInlineMessage").mockImplementation(async (_userId, result) => {
    throw rejectedResult("savePreparedInlineMessage", [result]);
  });
  try {
    await f.meme("prepared-photo", 101);
    const req = new Request(`${f.env.PUBLIC_URL}/app/api/memes/prepared-photo/share`, {
      method: "POST", headers: { Cookie: `session=${await createSession(f.env, 101)}` },
    });
    const response = (await handleApp(req, f.env, {} as ExecutionContext))!;
    expect(response.status).toBe(502);
    expect(await response.json<{ error: string }>()).toEqual({ error: "telegram" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([["savePreparedInlineMessage failed", "Telegram API error", 400]]);
    expect(await f.env.DB.prepare("SELECT count(*) FROM meme_uses").first<number>("count(*)")).toBe(0);
  } finally { send.mockRestore(); log.mockRestore(); f.close(); }
});

test("webhook failures do not pass signed inline results to the HTTP error handler", async () => {
  const f = await fixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  const getMe = spyOn(Api.prototype, "getMe").mockResolvedValue(me);
  const sync = spyOn(Api.prototype, "setChatMenuButton").mockRejectedValue(new HttpError("private URL", new Error("private cause")));
  const answer = spyOn(Api.prototype, "answerInlineQuery").mockImplementation(async (_id, results) => {
    throw rejectedResult("answerInlineQuery", results);
  });
  try {
    await f.meme("webhook-photo", 101);
    f.env.WEBHOOK_SECRET = "offline-webhook";
    const req = new Request(`${f.env.PUBLIC_URL}/webhook`, {
      method: "POST", body: JSON.stringify(update), headers: { "X-Telegram-Bot-Api-Secret-Token": f.env.WEBHOOK_SECRET },
    });
    const pending: Promise<unknown>[] = [];
    const response = await handleBotWebhook(req, f.env, {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    } as ExecutionContext);
    await Promise.all(pending);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal server error");
    expect(answer).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls).toEqual(expect.arrayContaining([
      ["command sync failed", "Telegram transport error"],
      ["bot webhook failed", "Telegram API error", 400],
    ]));
  } finally { answer.mockRestore(); sync.mockRestore(); getMe.mockRestore(); log.mockRestore(); f.close(); }
});
