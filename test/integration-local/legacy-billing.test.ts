import { expect, spyOn, test } from "bun:test";
import { Api } from "grammy";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { allowanceLeft } from "../../src/billing";
import { getInvoice, handleBtcpay } from "../../src/crypto";
import { getUser } from "../../src/db";
import { createDatabase } from "../../src/runtime/db";
import { fixture } from "./fixture";

const day = 86400;
const now = () => Math.floor(Date.now() / 1000);

test("legacy billing migration covers prepaid discounted time without adding time, resetting spend, or replaying receipts", async () => {
  const migrations = join(import.meta.dir, "../../migrations");
  const root = mkdtempSync(join(import.meta.dir, "billing-migration-"));
  const newest = "0046_legacy_billing.sql";
  try {
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql") && f < newest)) {
      writeFileSync(join(root, file), readFileSync(join(migrations, file)));
    }
    const path = join(root, "billing.sqlite");
    const until = now() + 40 * day;
    const started = now() - day;
    const first = createDatabase(path, root);
    try {
      await first.exec(`INSERT INTO users (id, role, plan, plan_byok, paid_until, allowance_until, plan_started, balance, sub_charge_id, sub_state) VALUES
        (1, 'paid', 'monthly', 1, ${until}, NULL, ${started}, 0.25, 'old-stars', 'active'),
        (2, 'paid', 'yearly', 0, ${until}, ${until - 30 * day}, ${started}, 0, NULL, NULL),
        (3, 'paid', 'monthly', 1, ${started}, NULL, ${started}, 0, NULL, NULL),
        (4, 'paid', 'monthly', 0, ${until}, ${until}, ${started}, 0, 'standard', 'active');
        INSERT INTO payments (user_id, method, kind, byok, usd, charge_id) VALUES
        (1, 'stars', 'monthly', 1, 0.5, 'old-stars'), (2, 'btcpay', 'monthly', 1, 0.5, 'btcpay:already-paid'),
        (4, 'stars', 'monthly', 0, 1, 'standard');
        INSERT INTO transactions (user_id, kind, model, key_source, cost, from_allowance) VALUES (2,'describe','m','global',0.25,0.25);`);
    } finally { first.close(); }

    const db = createDatabase(path, migrations);
    try {
      const original = await getUser(db, 1);
      const mixed = (await getUser(db, 2))!;
      expect(original).toMatchObject({ paid_until: until, allowance_until: until, plan_started: started, plan_byok: 0, balance: 0.25 });
      expect(mixed).toMatchObject({ paid_until: until, allowance_until: until, plan_started: started });
      expect(await allowanceLeft(db, mixed)).toBeCloseTo(0.25);
      expect(await getUser(db, 3)).toMatchObject({ paid_until: started, allowance_until: null, plan_byok: 1 });
      expect(await getUser(db, 4)).toMatchObject({ paid_until: until, allowance_until: until, sub_state: "active" });
      expect((await db.prepare("SELECT charge_id, user_id, canceled_at FROM legacy_stars_cancellations").all()).results).toEqual([
        { charge_id: "old-stars", user_id: 1, canceled_at: null },
      ]);
      expect((await db.prepare("SELECT byok, usd, charge_id FROM payments WHERE byok = 1 ORDER BY id").all()).results).toEqual([
        { byok: 1, usd: 0.5, charge_id: "old-stars" }, { byok: 1, usd: 0.5, charge_id: "btcpay:already-paid" },
      ]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true }); }
});

test("a confirmed late discounted BTCPay settlement gets standard coverage once at the original price", async () => {
  const f = await fixture();
  const send = spyOn(Api.prototype, "sendMessage").mockRejectedValue(new Error(`https://api.telegram.org/bot${f.env.BOT_TOKEN}/sendMessage`));
  const log = spyOn(console, "error").mockImplementation(() => {});
  const secret = "offline-btcpay-signing-test";
  Object.assign(f.env, { BTCPAY_URL: "https://pay.invalid", BTCPAY_STORE_ID: "store", BTCPAY_API_KEY: "offline", BTCPAY_WEBHOOK_SECRET: secret });
  const post = (invoiceId: string) => {
    const body = JSON.stringify({ type: "InvoiceSettled", invoiceId });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    return handleBtcpay(new Request("https://local.invalid/pay/btcpay", { method: "POST", body, headers: { "BTCPay-Sig": `sha256=${signature}` } }), f.env);
  };
  let status = "Processing";
  const fetchStub = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    expect(String(input)).toMatch(/^https:\/\/pay\.invalid\/api\/v1\/stores\/store\/invoices\/(late|stale)$/);
    return Response.json({ status });
  }, { preconnect: fetch.preconnect }));
  try {
    const at = now();
    const until = at + day;
    await f.env.DB.exec(`INSERT INTO users (id, role, paid_until, allowance_until, plan_started) VALUES (31,'paid',${until},${until},${at});
      INSERT INTO crypto_invoices (id,user_id,provider,kind,byok,usd,provider_ref,status) VALUES
        ('delayed',31,'btcpay','monthly',1,0.5,'late','expired'),
        ('settled-before-upgrade',31,'btcpay','monthly',1,0.5,'old-paid','paid'),
        ('stale-status',31,'btcpay','monthly',1,0.5,'stale','pending');
      INSERT INTO payments (user_id,method,kind,byok,usd,charge_id) VALUES (31,'btcpay','monthly',1,0.5,'btcpay:stale-status');`);
    expect((await post("old-paid")).status).toBe(200);
    expect((await post("late")).status).toBe(200);
    expect(await getUser(f.env.DB, 31)).toMatchObject({ paid_until: until, allowance_until: until });
    status = "Settled";
    expect((await post("stale")).status).toBe(200);
    expect(await getUser(f.env.DB, 31)).toMatchObject({ paid_until: until, allowance_until: until });
    expect((await Promise.all([post("late"), post("late")])).map((res) => res.status)).toEqual([200, 200]);
    expect((await post("late")).status).toBe(200);

    expect(await getUser(f.env.DB, 31)).toMatchObject({ paid_until: until + 30 * day, allowance_until: until + 30 * day, plan_byok: 0, balance: 0 });
    expect(await getInvoice(f.env.DB, "delayed")).toMatchObject({ status: "paid", credited_usd: 0.5 });
    expect((await f.env.DB.prepare("SELECT charge_id, byok, usd FROM payments ORDER BY id").all()).results).toEqual([
      { charge_id: "btcpay:stale-status", byok: 1, usd: 0.5 }, { charge_id: "btcpay:delayed", byok: 1, usd: 0.5 },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([["billing: send BTCPay receipt failed"]]);
  } finally { fetchStub.mockRestore(); log.mockRestore(); send.mockRestore(); f.close(); }
});
