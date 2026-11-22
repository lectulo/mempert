import { ALLOWANCE_MONTH, selfHosted, spendNotices } from "./billing";
import { pushBalance } from "./billingbot";
import { MONTHLY_ALLOWANCE } from "./config";
import type { User } from "./db";
import type { Env } from "./env";

export interface Spend {
  userId: number;
  kind: string;
  memeId?: string;
}

export interface Usage {
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface TokenPrices {
  prompt: number;
  completion: number;
  cacheWrite: number;
  cacheRead: number;
}

const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const count = (n: unknown) => nonnegative(n) ? n : 0;

/** Provider cost takes precedence, including a reported zero. Cache counters are parts of the prompt total. */
function knownCost(usage?: Usage, prices?: TokenPrices): number | undefined {
  if (!usage) return;
  if (nonnegative(usage.cost)) return usage.cost;
  if (!prices || !(nonnegative(usage.prompt_tokens) || nonnegative(usage.completion_tokens))) return;
  const prompt = count(usage.prompt_tokens);
  const read = Math.min(prompt, count(usage.prompt_tokens_details?.cached_tokens));
  const written = Math.min(prompt - read, count(usage.prompt_tokens_details?.cache_write_tokens));
  const cost = (prompt - read - written) / 1e6 * prices.prompt + read / 1e6 * prices.cacheRead
    + written / 1e6 * prices.cacheWrite + count(usage.completion_tokens) / 1e6 * prices.completion;
  if (nonnegative(cost)) return cost;
}

export const effectiveCost = (usage: Usage, prices?: TokenPrices) => knownCost(usage, prices) ?? 0;

export const hasReportedUsage = (usage?: Usage | null): boolean =>
  nonnegative(usage?.cost) || nonnegative(usage?.prompt_tokens) || nonnegative(usage?.completion_tokens);

export function logMissingUsage(kind: string) {
  console.warn("AI usage missing", { kind });
}

type Billed = { from_allowance: number; from_balance: number };
type BatchReceipt = { batchId: string; importId: string };

/** Read the current allowance and allocate the cost in the write transaction, not in a preceding request. */
async function writeSpend(
  env: Env, s: Spend, model: string, keySource: "global" | "user", usage?: Usage | null,
  prices?: TokenPrices, receipt?: BatchReceipt,
) {
  const db = env.DB;
  const known = knownCost(usage ?? undefined, prices);
  const cost = known ?? 0;
  const bill = keySource === "global" && cost > 0 && !selfHosted(env);
  const unseen = "NOT EXISTS (SELECT 1 FROM batch_spend_receipts WHERE batch_id = ?)";
  const [ledger, accounts] = await db.batch<Billed | User>([
    db.prepare(`WITH account AS (
      SELECT u.id, unixepoch() AS at, COALESCE(u.plan_started, unixepoch()) AS started,
        u.allowance_until, (?9 AND u.role = 'paid') AS bill
      FROM (SELECT 1) LEFT JOIN users u ON u.id = ?1
    ), allocation AS (
      SELECT COALESCE(bill, 0) AS bill, at,
        CASE WHEN bill AND allowance_until > at THEN
          MIN(?5, MAX(0, ?10 - COALESCE((SELECT SUM(from_allowance) FROM transactions
            WHERE user_id = account.id AND created_at >= started + (MAX(0, at - started) / ?11) * ?11), 0)))
        ELSE 0 END AS included
      FROM account
    )
    INSERT INTO transactions (user_id, kind, model, key_source, cost, prompt_tokens, completion_tokens, meme_id, from_allowance, from_balance, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, included, CASE WHEN bill THEN ?5 - included ELSE 0 END, at
    FROM allocation ${receipt ? `WHERE ${unseen}` : ""}
    RETURNING from_allowance, from_balance`)
      .bind(s.userId, s.kind, model, keySource, cost,
        nonnegative(usage?.prompt_tokens) ? usage.prompt_tokens : null,
        nonnegative(usage?.completion_tokens) ? usage.completion_tokens : null,
        s.memeId ?? null, bill ? 1 : 0, MONTHLY_ALLOWANCE, ALLOWANCE_MONTH, ...(receipt ? [receipt.batchId] : [])),
    // Only read the row just inserted by the preceding statement in this transaction.
    // The same receipt check prevents a replay from using a stale last_insert_rowid().
    db.prepare(`UPDATE users SET total_cost = total_cost + ?, balance = balance -
      (SELECT from_balance FROM transactions WHERE id = last_insert_rowid())
      WHERE id = ? ${receipt ? `AND ${unseen}` : ""} RETURNING *`)
      .bind(cost, s.userId, ...(receipt ? [receipt.batchId] : [])),
    ...(receipt ? [
      db.prepare(`UPDATE imports SET cost = cost + ? WHERE id = ? AND ${unseen}`).bind(cost, receipt.importId, receipt.batchId),
      db.prepare("INSERT OR IGNORE INTO batch_spend_receipts (batch_id, import_id) VALUES (?, ?)").bind(receipt.batchId, receipt.importId),
    ] : []),
  ]);
  const billed = ledger.results[0] as Billed | undefined;
  if (billed && known === undefined) {
    if (hasReportedUsage(usage)) console.warn("AI cost unavailable for reported usage", { kind: s.kind });
    else logMissingUsage(s.kind);
  }
  return { billed, user: accounts.results[0] as User | undefined };
}

/** Saves one AI attempt's usage, charging paid users on the shared key from allowance first. */
export async function recordSpend(env: Env, s: Spend, model: string, keySource: "global" | "user", usage?: Usage | null, prices?: TokenPrices) {
  const { billed, user } = await writeSpend(env, s, model, keySource, usage, prices);
  if (user && billed && (billed.from_allowance || billed.from_balance)) {
    await spendNotices(env, user, billed.from_allowance, billed.from_balance).catch(console.error);
    await pushBalance(env, user.id).catch(console.error);
  }
}

/** Receipt, ledger, balance and import cost commit together. Replaying a received batch is a no-op. */
export async function recordBatchSpend(env: Env, userId: number, model: string, keySource: "global" | "user", usage: Usage | undefined, receipt: BatchReceipt) {
  await writeSpend(env, { userId, kind: "describe_batch" }, model, keySource, usage, undefined, receipt);
}
