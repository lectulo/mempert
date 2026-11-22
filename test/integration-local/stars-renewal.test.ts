import { expect, spyOn, test } from "bun:test";
import { Api, Bot } from "grammy";
import type { SuccessfulPayment, Update } from "grammy/types";
import { allowanceLeft, billingNotices, notifyOnce } from "../../src/billing";
import { registerPayments } from "../../src/billingbot";
import type { Ctx } from "../../src/bot";
import { getUser } from "../../src/db";
import { fixture } from "./fixture";

const buyer = { id: 31, is_bot: false, first_name: "Buyer" };
const invoice = (b: 0 | 1, k = "monthly", s = b ? 40 : 80) => JSON.stringify({ u: buyer.id, k, b, s });
const day = 86400;

async function paymentFixture(failCancel = false) {
  const f = await fixture();
  await f.env.DB.exec("INSERT INTO users(id,role) VALUES(31,'paid');");
  const user = async () => (await getUser(f.env.DB, buyer.id))!;
  const apiCalls: { method: string; payload: unknown }[] = [];
  const bot = new Bot<Ctx>(f.env.BOT_TOKEN, {
    botInfo: { id: 1, first_name: "Bot", username: "test_bot", is_bot: true, can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
  });
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (failCancel && method === "editUserStarSubscription") {
      throw new Error("network failure", { cause: new Error(`https://api.telegram.org/bot${f.env.BOT_TOKEN}/${method}`) });
    }
    return { ok: true, result: true } as never;
  });
  bot.use(async (ctx, next) => {
    ctx.lang = "en";
    ctx.user = await user();
    await next();
  });
  registerPayments(bot, f.env);
  let id = 0;
  const update = (data: Omit<Update, "update_id">) => bot.handleUpdate({ update_id: ++id, ...data });
  const checkout = (payload: string, amount: number) => update({ pre_checkout_query: { id: `checkout-${id}`, from: buyer, currency: "XTR", total_amount: amount, invoice_payload: payload } });
  const paid = (charge: string, payload: string, amount: number, flags: Partial<SuccessfulPayment> = {}) => update({ message: {
    message_id: id + 1, date: Math.floor(Date.now() / 1000), chat: { ...buyer, type: "private" }, from: buyer,
    successful_payment: { currency: "XTR", total_amount: amount, invoice_payload: payload, telegram_payment_charge_id: charge, provider_payment_charge_id: "", ...flags },
  } });
  return { ...f, user, apiCalls, update, checkout, paid };
}

test("Stars checkout rejects old discounted invoices but accepts standard plans and top-ups", async () => {
  const f = await paymentFixture();
  try {
    await f.checkout(invoice(1), 40);
    await f.checkout(invoice(1, "yearly", 310), 310);
    await f.checkout(invoice(0), 80);
    await f.checkout(invoice(0, "topup", 100), 100);
    expect(f.apiCalls.map(({ method, payload }) => [method, (payload as { ok: boolean }).ok])).toEqual([
      ["answerPreCheckoutQuery", false], ["answerPreCheckoutQuery", false], ["answerPreCheckoutQuery", true], ["answerPreCheckoutQuery", true],
    ]);
  } finally { f.close(); }
});

test("a legacy Stars renewal already collected is honored once with allowance and old auto-renew is stopped", async () => {
  const f = await paymentFixture();
  try {
    const until = Math.floor(Date.now() / 1000) + day;
    await f.env.DB.exec(`INSERT INTO payments(user_id,method,kind,byok,usd,charge_id) VALUES(31,'stars','monthly',1,0.5,'legacy-first');
      UPDATE users SET plan='monthly', plan_byok=1, sub_charge_id='legacy-first', sub_state='active', paid_until=${until} WHERE id=31;`);
    await f.paid("renewal", invoice(1), 40, { is_recurring: true });
    await f.paid("renewal", invoice(1), 40, { is_recurring: true });
    const user = await f.user();
    expect(user).toMatchObject({ plan_byok: 0, paid_until: until + 30 * day, sub_state: "canceled", sub_charge_id: "legacy-first" });
    expect(await allowanceLeft(f.env.DB, user)).toBeGreaterThan(0);
    expect(await f.env.DB.prepare("SELECT kind, byok, usd, stars, recurring FROM payments WHERE charge_id='renewal'").first<Record<string, unknown>>()).toEqual({ kind: "monthly", byok: 1, usd: 0.5, stars: 40, recurring: 1 });
    expect(f.apiCalls.filter(({ method }) => method === "editUserStarSubscription")).toEqual([
      { method: "editUserStarSubscription", payload: { user_id: buyer.id, telegram_payment_charge_id: "legacy-first", is_canceled: true } },
    ]);
    expect(f.apiCalls.filter(({ method }) => method === "sendMessage")).toHaveLength(1);

    await f.paid("standard-first", invoice(0), 80, { is_recurring: true, is_first_recurring: true });
    await f.update({ subscription: { user: buyer, state: "canceled", invoice_payload: invoice(1) } });
    await f.paid("late-legacy-first", invoice(1), 40, { is_recurring: true, is_first_recurring: true });
    expect(await f.user()).toMatchObject({ sub_state: "active", sub_charge_id: "standard-first" });
    expect(f.apiCalls.filter(({ method }) => method === "editUserStarSubscription").map(({ payload }) => payload)).toEqual([
      { user_id: buyer.id, telegram_payment_charge_id: "legacy-first", is_canceled: true },
      { user_id: buyer.id, telegram_payment_charge_id: "late-legacy-first", is_canceled: true },
    ]);
  } finally { f.close(); }
});

test("scheduled billing cancels the old Stars subscription without shortening prepaid access", async () => {
  const f = await paymentFixture();
  const cancel = spyOn(Api.prototype, "editUserStarSubscription").mockResolvedValue(true);
  try {
    const until = Math.floor(Date.now() / 1000) + day;
    await f.env.DB.exec(`INSERT INTO users(id,role) VALUES(32,'paid');
      INSERT INTO payments(user_id,method,kind,byok,usd,charge_id) VALUES
        (31,'stars','monthly',1,0.5,'old-sub'), (32,'stars','monthly',0,1,'standard-sub');
      UPDATE users SET plan='yearly', sub_charge_id='old-sub', sub_state='active', paid_until=${until}, allowance_until=${until} WHERE id=31;
      UPDATE users SET plan='monthly', plan_byok=1, sub_charge_id='standard-sub', sub_state='active' WHERE id=32;`);
    await billingNotices(f.env);
    await billingNotices(f.env);
    expect(cancel.mock.calls.map(([userId, charge, canceled]) => [userId, charge, canceled])).toEqual([[31, "old-sub", true]]);
    expect(await f.user()).toMatchObject({ sub_state: "canceled", paid_until: until, allowance_until: until });
    expect(await getUser(f.env.DB, 32)).toMatchObject({ sub_state: "active" });
  } finally { cancel.mockRestore(); f.close(); }
});

test("an already paid legacy yearly invoice keeps its original charge and gets standard coverage", async () => {
  const f = await paymentFixture();
  try {
    const start = Math.floor(Date.now() / 1000);
    await f.paid("old-yearly", invoice(1, "yearly", 310), 310);
    const user = await f.user();
    expect(user.plan).toBe("yearly");
    expect(user.paid_until).toBeGreaterThanOrEqual(start + 360 * day);
    expect(user.allowance_until).toBe(user.paid_until);
    expect(await f.env.DB.prepare("SELECT usd FROM payments WHERE charge_id='old-yearly'").first<number>("usd")).toBe(4);
    expect(f.apiCalls.map(({ method }) => method)).toEqual(["sendMessage"]);
  } finally { f.close(); }
});

test("failed Stars cancellations survive a replacement, duplicate deliveries and a database reopen", async () => {
  const f = await paymentFixture(true);
  const failure = () => new Error(`https://api.telegram.org/bot${f.env.BOT_TOKEN}/editUserStarSubscription`);
  const log = spyOn(console, "error").mockImplementation(() => {});
  const first = { is_recurring: true, is_first_recurring: true } as const;
  try {
    await f.paid("legacy-first", invoice(1), 40, first);
    await f.paid("standard-first", invoice(0), 80, first);
    await f.paid("late-legacy-first", invoice(1), 40, first);
    const before = await f.user();
    expect(before).toMatchObject({ sub_charge_id: "standard-first", sub_state: "active" });
    await f.reopen();
    const cancel = spyOn(Api.prototype, "editUserStarSubscription").mockRejectedValue(failure());
    try {
      const canceledCharges = () => cancel.mock.calls.map(([, charge]) => charge).sort();
      await billingNotices(f.env); // Scheduled cancellation also fails without logging the raw error.
      expect(canceledCharges()).toEqual(["late-legacy-first", "legacy-first"]);
      expect(log.mock.calls).toEqual(Array.from({ length: 6 }, () => ["billing: cancel legacy Stars renewal failed"]));

      cancel.mockClear();
      cancel.mockResolvedValue(true);
      // Simulate an interrupted worker whose durable lease has since expired.
      await f.env.DB.prepare("UPDATE legacy_stars_cancellations SET lease_until = unixepoch() - 1 WHERE charge_id = 'legacy-first'").run();
      await Promise.all([billingNotices(f.env), billingNotices(f.env)]);
      await f.paid("late-legacy-first", invoice(1), 40, first);
      await billingNotices(f.env);
      expect(canceledCharges()).toEqual(["late-legacy-first", "legacy-first"]);
    } finally { cancel.mockRestore(); }
    expect(await f.user()).toMatchObject({ sub_charge_id: "standard-first", sub_state: "active", paid_until: before.paid_until, allowance_until: before.allowance_until });
    expect(f.apiCalls.filter(({ method }) => method === "sendMessage")).toHaveLength(3);
  } finally { log.mockRestore(); f.close(); }
});

test("scheduled billing notice failures never log the Telegram transport error", async () => {
  const f = await paymentFixture();
  const send = spyOn(Api.prototype, "sendMessage").mockRejectedValue(new Error("network failure", {
    cause: new Error(`https://api.telegram.org/bot${f.env.BOT_TOKEN}/sendMessage`),
  }));
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    f.env.SELF_HOSTED = "false";
    const at = Math.floor(Date.now() / 1000);
    await f.env.DB.prepare("UPDATE users SET paid_until = ?, plan = 'monthly' WHERE id = 31").bind(at + day).run();
    await billingNotices(f.env, at);
    expect(log.mock.calls).toEqual([["billing: send notice failed"]]);
    expect(await notifyOnce(f.env, buyer.id, `expiry1:${at + day}`, "duplicate")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); send.mockRestore(); f.close(); }
});
