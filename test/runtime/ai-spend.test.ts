import { expect, spyOn, test } from "bun:test";
import { Api } from "grammy";
import { MONTHLY_ALLOWANCE } from "../../src/config";
import { createDatabase } from "../../src/runtime/db";
import { effectiveCost, recordBatchSpend, recordSpend } from "../../src/spend";
import type { Env } from "../../src/env";

const prices = { prompt: 10, completion: 20, cacheRead: 1, cacheWrite: 12 };
const usage = {
  prompt_tokens: 100_000,
  completion_tokens: 50_000,
  prompt_tokens_details: { cached_tokens: 60_000, cache_write_tokens: 10_000 },
};

test("usage cost wins over configured prices, even when zero", () => {
  expect(effectiveCost({ ...usage, cost: 0 }, prices)).toBe(0);
  expect(effectiveCost({ ...usage, cost: 0.75 }, prices)).toBe(0.75);
});

test("each prompt token is priced once at its cache or regular rate", () => {
  for (const cost of [undefined, -1, Infinity, NaN]) {
    expect(effectiveCost({ ...usage, cost }, prices)).toBeCloseTo(1.48);
  }
  expect(effectiveCost({ prompt_tokens: 100_000 }, prices)).toBe(1);
});

test("invalid counters cannot make remaining tokens or cost negative", () => {
  expect(effectiveCost({ prompt_tokens: 100_000, completion_tokens: -1,
    prompt_tokens_details: { cached_tokens: 110_000, cache_write_tokens: 200_000 } }, prices)).toBe(0.1);
  expect(effectiveCost({ prompt_tokens: NaN, completion_tokens: Infinity, cost: -2 }, prices)).toBe(0);
  expect(effectiveCost(usage)).toBe(0); // fixed endpoints without configured prices
});

test("concurrent online spend and replayed batch spend share one allowance", async () => {
  const db = createDatabase(":memory:", `${import.meta.dir}/../../migrations`);
  const env = { DB: db, SELF_HOSTED: "false", BOT_TOKEN: "1:test" } as unknown as Env;
  const send = spyOn(Api.prototype, "sendMessage").mockResolvedValue({ message_id: 1 } as never);
  try {
    await db.prepare(`INSERT INTO users (id, role, plan_started, allowance_until, balance)
      VALUES (196, 'paid', unixepoch()-31*86400, unixepoch()+86400, 2)`).run();
    await db.prepare(`INSERT INTO transactions (user_id, kind, model, key_source, cost, from_allowance, created_at)
      VALUES (196, 'last-month', 'model', 'global', ?1, ?1, unixepoch()-2*86400)`).bind(MONTHLY_ALLOWANCE).run();
    await db.prepare("INSERT INTO imports (id,user_id,status) VALUES ('spend',196,'processing')").run();
    const cost = MONTHLY_ALLOWANCE * 0.75;
    const usage = { cost };
    const batch = () => recordBatchSpend(env, 196, "model", "global", usage, { batchId: "batch-spend", importId: "spend" });
    await Promise.all([
      recordSpend(env, { userId: 196, kind: "online" }, "model", "global", usage),
      batch(),
      recordSpend(env, { userId: 196, kind: "online" }, "model", "global", usage),
      batch(),
    ]);
    await batch(); // Also replay after unrelated inserts on the same connection.

    const { results } = await db.prepare(`SELECT kind, cost, from_allowance, from_balance
      FROM transactions WHERE kind <> 'last-month' ORDER BY id`).all<{ kind: string; cost: number; from_allowance: number; from_balance: number }>();
    expect(results).toHaveLength(3);
    expect(results.filter((row) => row.kind === "describe_batch")).toHaveLength(1);
    for (const row of results) expect(row.from_allowance + row.from_balance).toBeCloseTo(row.cost);
    expect(results.reduce((sum, row) => sum + row.from_allowance, 0)).toBeCloseTo(MONTHLY_ALLOWANCE);
    expect(await db.prepare("SELECT total_cost,balance FROM users WHERE id=196").first<{ total_cost: number; balance: number }>()).toEqual({
      total_cost: 3 * cost, balance: 2 - (3 * cost - MONTHLY_ALLOWANCE),
    });
    expect(await db.prepare("SELECT cost FROM imports WHERE id='spend'").first<number>("cost")).toBe(cost);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM batch_spend_receipts").first<number>("n")).toBe(1);
  } finally {
    send.mockRestore();
    db.close();
  }
});

test("a failed batch receipt write rolls back the ledger and both balances", async () => {
  const db = createDatabase(":memory:", `${import.meta.dir}/../../migrations`);
  const env = { DB: db, SELF_HOSTED: "false" } as unknown as Env;
  try {
    await db.exec(`INSERT INTO users (id,role,balance) VALUES (197,'paid',2);
      INSERT INTO imports (id,user_id,status) VALUES ('rollback',197,'processing');
      CREATE TRIGGER reject_test_receipt BEFORE INSERT ON batch_spend_receipts
        BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;`);
    const batch = () => recordBatchSpend(env, 197, "model", "global", { cost: 0.125 }, { batchId: "batch-rollback", importId: "rollback" });
    const user = () => db.prepare("SELECT total_cost, balance FROM users WHERE id=197").first<{ total_cost: number; balance: number }>();
    const cost = () => db.prepare("SELECT cost FROM imports WHERE id='rollback'").first<number>("cost");
    const transactions = () => db.prepare("SELECT COUNT(*) AS n FROM transactions").first<number>("n");
    await expect(batch()).rejects.toThrow("receipt failed");
    expect(await transactions()).toBe(0);
    expect(await user()).toEqual({ total_cost: 0, balance: 2 });
    expect(await cost()).toBe(0);

    await db.exec("DROP TRIGGER reject_test_receipt");
    await batch();
    expect(await transactions()).toBe(1);
    expect(await user()).toEqual({ total_cost: 0.125, balance: 1.875 });
    expect(await cost()).toBe(0.125);
  } finally {
    db.close();
  }
});
