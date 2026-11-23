import { expect, test } from "bun:test";
import { adminAnalytics } from "../../src/analytics";
import { fixture } from "./fixture";

test("admin analytics works with no payments", async () => {
  const f = await fixture();
  try {
    await f.db.exec("INSERT INTO users (id, role) VALUES (1, 'admin'), (2, 'paid')");
    const { payments, table } = await adminAnalytics(f.env);
    expect(payments).toEqual([]);
    expect(table.users.map((user) => user.id).sort()).toEqual([1, 2]);
  } finally { f.close(); }
});

test("admin analytics groups non-refunded payments by UTC creation month and method", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`INSERT INTO users (id, role) VALUES (1, 'admin'), (2, 'paid');
      INSERT INTO payments (user_id, method, kind, usd, charge_id, refunded, created_at) VALUES
        (2, 'stars',  'topup', 2.50, 'feb-stars',          0, unixepoch('2025-02-01 00:00:00')),
        (2, 'stars',  'topup', 1.25, 'jan-stars',          0, unixepoch('2025-01-31 23:59:59')),
        (1, 'stars',  'topup', 0.75, 'jan-stars-admin',    0, unixepoch('2025-01-01 00:00:00')),
        (2, 'btcpay', 'topup', 4.00, 'jan-btc',            0, unixepoch('2025-01-31 23:59:59')),
        (2, 'stars',  'topup', 9.00, 'jan-stars-refunded', 1, unixepoch('2025-01-31 23:59:59')),
        (2, 'btcpay', 'topup', 8.00, 'mar-btc-refunded',   1, unixepoch('2025-03-01 00:00:00'));`);
    const { payments } = await adminAnalytics(f.env);
    expect(payments.map((p) => p.month)).toEqual(["2025-01", "2025-01", "2025-02"]);
    expect(payments).toEqual(expect.arrayContaining([
      { month: "2025-01", method: "btcpay", usd: 4, n: 1 },
      { month: "2025-01", method: "stars", usd: 2, n: 2 },
      { month: "2025-02", method: "stars", usd: 2.5, n: 1 },
    ]));
  } finally { f.close(); }
});
