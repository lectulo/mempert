import { botApi } from "./botapi";
import { batchEnabled } from "./batchmode";
import { DESCRIBE_MODELS, MODELS } from "./config";
import { getMeme, userLang, type Meme } from "./db";
import type { Env } from "./env";
import { push } from "./live";
import { esc, t, usd, type Key } from "./i18n";
import { describeRequest, isBlocked, parseAnswer, saveDescription, topTags, userTier } from "./ingest/describe";
import { hasExt, memeMedia, signedMediaUrl } from "./media";
import { presignedR2Url } from "./presign";
import { rekeyStage } from "./rekey";
import { createBatch, errorNote, getBatch, openRouterKey, type Batch, type KeySource } from "./openrouter";
import type { Job } from "./queue";
import { recordBatchSpend } from "./spend";

const BATCH_MAX = 5000; // OpenRouter limit per batch
const MEDIA_TTL = 5 * 86400; // longer than the 96 h Vertex window, shorter than the 7-day R2 lifecycle
const RUNNING = ["validating", "in_progress", "finalizing"];
const MAX_ATTEMPTS = 3; // batch submits per import before giving up on failed photos
// After the last attempt only a few stragglers go to the full-price pipeline; a batch that mostly failed
// (e.g. the provider rejected it) is stopped instead of being re-run at twice the cost.
const fallbackLimit = (photos: number) => Math.max(5, Math.ceil(photos * 0.1));
export const BATCH_DISABLED_ERROR = "Batch imports are disabled; photos were not sent to full-price processing";

interface Import {
  id: string;
  user_id: number;
  status: string;
  batch_id: string | null;
  key_source: KeySource | null;
  status_msg_id: number | null;
  attempts: number;
  described: number;
  cost: number;
  model: string | null;
  submission_started: number;
}

type Status = Pick<Import, "user_id" | "status_msg_id">;

/** Progress: edits the import's status message from /batch_finish. */
async function progress(env: Env, imp: Status, key: Key, params: Record<string, string | number> = {}) {
  await push(env, imp.user_id, { t: "job", kind: "batch" });
  const text = t(await userLang(env.DB, imp.user_id), key, params);
  const api = botApi(env.BOT_TOKEN);
  const html = { parse_mode: "HTML" } as const;
  const sent = imp.status_msg_id ? api.editMessageText(imp.user_id, imp.status_msg_id, text, html) : api.sendMessage(imp.user_id, text, html);
  await sent.catch(console.error);
}

/** Completion: a new message (so the user gets a notification), as a reply to the status message. */
async function notify(env: Env, imp: Status, key: Key, params: Record<string, string | number> = {}) {
  await push(env, imp.user_id, { t: "job", kind: "batch" });
  const text = t(await userLang(env.DB, imp.user_id), key, params);
  const reply = imp.status_msg_id ? { reply_parameters: { message_id: imp.status_msg_id, allow_sending_without_reply: true } } : {};
  await botApi(env.BOT_TOKEN).sendMessage(imp.user_id, text, { parse_mode: "HTML", ...reply }).catch(console.error);
}

async function sendJobs(env: Env, jobs: Job[]) {
  for (let i = 0; i < jobs.length; i += 100) await env.JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
}

const describeJobs = (memes: Meme[]): Job[] => memes.map((m) => ({ type: "describe", memeId: m.id, gen: m.gen }));

function continuation(db: D1Database, job: Job) {
  const body = JSON.stringify(job);
  return db.prepare("INSERT OR IGNORE INTO batch_continuations (id, body) VALUES (?, ?)").bind(body, body);
}

/** At-least-once enqueue: never delete the durable intent before send succeeds. */
export async function flushBatchContinuations(env: Env) {
  const disabled = !batchEnabled(env);
  const { results } = await env.DB.prepare("SELECT id, body FROM batch_continuations").all<{ id: string; body: string }>();
  for (const row of results) {
    const job = JSON.parse(row.body) as Job;
    if (disabled && job.type === "batch_submit") {
      await stopUnsubmittedImport(env, job.importId);
    } else if (disabled && job.type === "describe") {
      // These durable describe jobs are fallback work from an earlier batch poll.
      await env.DB.prepare("UPDATE memes SET status='failed', error=?, gen=gen+1, updated_at=unixepoch() WHERE id=? AND gen=? AND status='describing' AND title IS NULL")
        .bind(BATCH_DISABLED_ERROR, job.memeId, job.gen ?? 0).run();
    } else {
      await env.JOBS.send(job);
    }
    await env.DB.prepare("DELETE FROM batch_continuations WHERE id = ?").bind(row.id).run();
  }
}

/** Stop work that was collected but never handed to the provider, without queuing full-price descriptions. */
export async function stopUnsubmittedImport(env: Env, importId: string) {
  const [imports] = await env.DB.batch<Status>([
    env.DB.prepare(`UPDATE imports SET status='failed', error=?, updated_at=unixepoch()
      WHERE id=? AND status IN ('collecting','submitting') AND submission_started=0 RETURNING user_id, status_msg_id`)
      .bind(BATCH_DISABLED_ERROR, importId),
    env.DB.prepare(`UPDATE memes SET status='failed', error=?, gen=gen+1, updated_at=unixepoch()
      WHERE import_id=? AND status IN ('embedding','describing') AND title IS NULL
      AND NOT EXISTS (SELECT 1 FROM imports WHERE id=? AND NOT (status='failed' AND error IS ?))`)
      .bind(BATCH_DISABLED_ERROR, importId, importId, BATCH_DISABLED_ERROR),
  ]);
  await persistDescribedContinuations(env, importId);
  for (const imp of imports.results) {
    // The database transition is authoritative; don't block startup on Telegram.
    void notify(env, imp, "batch_disabled").catch(console.error);
  }
}

export async function stopUnsubmittedImports(env: Env) {
  if (batchEnabled(env)) return;
  const { results } = await env.DB.prepare("SELECT id FROM imports WHERE status IN ('collecting','submitting') AND submission_started=0").all<{ id: string }>();
  for (const imp of results) await stopUnsubmittedImport(env, imp.id);
}

/** Do not let stale description jobs (including album work) bypass the disabled batch policy. */
export async function stopBatchDescription(env: Env, m: Meme, from: number) {
  if (batchEnabled(env) || m.title !== null || (!m.import_id && from !== 1)) return false;
  // Submitted/processing photos stay pending for provider results. A queued
  // normal-price description is never needed for one of those photos.
  await env.DB.prepare(`UPDATE memes SET status='failed', error=?, gen=gen+1, updated_at=unixepoch()
    WHERE id=? AND gen=? AND status='describing' AND title IS NULL
    AND NOT EXISTS (SELECT 1 FROM imports WHERE id=memes.import_id
      AND (status IN ('submitted','processing') OR (status='submitting' AND submission_started=1)))`)
    .bind(BATCH_DISABLED_ERROR, m.id, m.gen).run();
  return true;
}

async function failUnknownSubmission(env: Env, imp: Import) {
  const error = "Batch submission interrupted: external outcome unknown; retry failed photos manually";
  await env.DB.batch([
    env.DB.prepare("UPDATE imports SET status='failed', error=? WHERE id=?").bind(error, imp.id),
    env.DB.prepare("UPDATE memes SET status='failed', error=? WHERE import_id=? AND title IS NULL AND status IN ('embedding','describing')").bind(error, imp.id),
  ]);
  await push(env, imp.user_id, { t: "job", kind: "batch" });
  // Unlike batch_failed, this must not promise automatic full-price fallback.
  // The durable SQL error is authoritative. Telegram availability must never
  // hold startup readiness behind network timeouts or auto-retry sleeps.
  void botApi(env.BOT_TOKEN).sendMessage(imp.user_id, error).catch(console.error);
}

/** Single-app startup only, after migrations and BEFORE queue consumers/pollers.
 * Safe to repeat. Does not query OpenRouter. Replays durable continuations and
 * re-polls known batches; unknown external submissions fail visibly, never resubmit.
 */
export async function recoverBatchImports(env: Env) {
  await env.DB.prepare("UPDATE imports SET status = 'submitted' WHERE status = 'processing' AND batch_id IS NOT NULL").run();
  await stopUnsubmittedImports(env);
  const { results } = await env.DB.prepare("SELECT * FROM imports WHERE status IN ('submitting', 'processing')").all<Import>();
  for (const imp of results) {
    if (imp.submission_started || imp.status === "processing") {
      await failUnknownSubmission(env, imp);
    } else if (batchEnabled(env)) {
      await continuation(env.DB, { type: "batch_submit", importId: imp.id }).run();
    }
  }
  const all = await env.DB.prepare("SELECT id FROM imports").all<{ id: string }>();
  for (const imp of all.results) await finishDescribed(env, imp.id);
  await flushBatchContinuations(env);
  if (await env.DB.prepare("SELECT 1 FROM imports WHERE status='submitted' LIMIT 1").first()) await env.JOBS.send({ type: "batch_poll" });
}

/** Memes of an import that still wait for a description. */
const pending = async (db: D1Database, importId: string) =>
  (
    await db
      .prepare("SELECT * FROM memes WHERE import_id = ? AND status IN ('embedding', 'describing') AND title IS NULL")
      .bind(importId)
      .all<Meme>()
  ).results;

export const collectingImport = (db: D1Database, userId: number) =>
  db.prepare("SELECT id FROM imports WHERE user_id = ? AND status = 'collecting'").bind(userId).first<string>("id");

export const countMemes = async (db: D1Database, importId: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM memes WHERE import_id = ?").bind(importId).first<number>("n")) ?? 0;

/** Opens batch mode. Returns the photo count when it was already open. */
export async function startImport(env: Env, userId: number): Promise<{ created: boolean; count: number }> {
  if (!batchEnabled(env)) return { created: false, count: 0 };
  const db = env.DB;
  const id = await db
    .prepare("INSERT INTO imports (id, user_id, status) VALUES (?, ?, 'collecting') ON CONFLICT DO NOTHING RETURNING id")
    .bind(crypto.randomUUID().replaceAll("-", ""), userId)
    .first<string>("id");
  if (id) return { created: true, count: 0 };
  return { created: false, count: await countMemes(db, (await collectingImport(db, userId))!) };
}

/** Recognize actionable failures without retaining provider error text or response bodies. */
export function batchError(batch: Batch): string {
  const error = batch.error ?? (batch.results ?? []).find((r) => r.error)?.error;
  const detail = JSON.stringify(error) ?? "";
  if (detail.includes("recognized image filename extension")) return "Batch image URLs require a recognized image filename extension";
  if (error && isBlocked(detail)) return "Batch request blocked by provider policy";
  if (error) return "Batch provider reported an error";
  return ["completed", "failed", "expired", "cancelled", ...RUNNING].includes(batch.status) ? `batch ${batch.status}` : "batch status unknown";
}

export interface ImportProgress {
  id: string;
  status: string;
  attempts: number;
  described: number;
  cost: number;
  created_at: number;
  photos: number;
  pending: number;
  failed: number;
  ready: number;
  live: { status: string; total: number; completed: number; failed: number } | null; // OpenRouter batch while it runs
}

/** Recent imports with per-photo progress and the live OpenRouter batch status (/batch_status and the app). */
export async function batchProgress(env: Env, userId: number): Promise<{ collecting: ImportProgress | null; recent: ImportProgress[]; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.status, i.attempts, i.described, i.cost, i.created_at, i.batch_id, i.key_source,
       COUNT(m.id) AS photos,
       SUM(m.status IN ('embedding', 'describing')) AS pending,
       SUM(m.status = 'failed') AS failed,
       SUM(m.status = 'ready') AS ready
     FROM imports i LEFT JOIN memes m ON m.import_id = i.id
     WHERE i.user_id = ? GROUP BY i.id ORDER BY i.created_at DESC LIMIT 6`,
  )
    .bind(userId)
    .all<ImportProgress & { batch_id: string | null; key_source: KeySource | null }>();
  const rows = await Promise.all(
    results.map(async ({ batch_id, key_source, ...r }) => {
      let live: ImportProgress["live"] = null;
      if (r.status === "submitted" && batch_id) {
        const b = await getBatch(env, userId, key_source ?? "global", batch_id).catch(() => null);
        if (b) live = { status: b.status, total: b.request_counts?.total ?? 0, completed: b.request_counts?.completed ?? 0, failed: b.request_counts?.failed ?? 0 };
      }
      return { ...r, pending: r.pending ?? 0, failed: r.failed ?? 0, ready: r.ready ?? 0, live };
    }),
  );
  const failed =
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM memes WHERE user_id = ? AND status = 'failed'").bind(userId).first<number>("n")) ?? 0;
  return { collecting: rows.find((r) => r.status === "collecting") ?? null, recent: rows.filter((r) => r.status !== "collecting"), failed };
}

/**
 * /batch_retry: failed photos go into a new half-price batch (stage 1 runs again first);
 * failed videos and GIFs go through the normal pipeline. Returns how many memes were retried.
 */
export async function retryFailed(env: Env, userId: number, statusMsgId: number | null) {
  if (!batchEnabled(env)) return { photos: 0, others: 0 };
  const db = env.DB;
  const importId = crypto.randomUUID().replaceAll("-", "");
  // Photos that already have a description skip the batch: describeStage reuses it and only finishes them.
  const [photos, others] = await db.batch<{ id: string; gen: number }>([
    db.prepare(
      "UPDATE memes SET status = 'embedding', error = NULL, import_id = ?, updated_at = unixepoch() WHERE user_id = ? AND status = 'failed' AND kind = 'photo' AND title IS NULL RETURNING id, gen",
    ).bind(importId, userId),
    db.prepare(
      "UPDATE memes SET status = 'embedding', error = NULL, import_id = NULL, updated_at = unixepoch() WHERE user_id = ? AND status = 'failed' RETURNING id, gen",
    ).bind(userId),
  ]);
  if (photos.results.length) {
    await db.prepare("INSERT INTO imports (id, user_id, status, status_msg_id) VALUES (?, ?, 'submitting', ?)").bind(importId, userId, statusMsgId).run();
  }
  const embed = [...photos.results, ...others.results].map((r): Job => ({ type: "embed", memeId: r.id, gen: r.gen }));
  await sendJobs(env, photos.results.length ? [...embed, { type: "batch_submit", importId }] : embed);
  return { photos: photos.results.length, others: others.results.length };
}

/** /batch_finish from the app: the bot posts the status message in the chat, as for the command. */
export async function finishImportFromApp(env: Env, userId: number): Promise<boolean> {
  if (!batchEnabled(env)) return false;
  const id = await collectingImport(env.DB, userId);
  if (!id) return false;
  const text = t(await userLang(env.DB, userId), "batch_finishing", { n: await countMemes(env.DB, id) });
  const msg = await botApi(env.BOT_TOKEN).sendMessage(userId, text, { parse_mode: "HTML" });
  return finishImport(env, userId, msg.message_id);
}

/** Closes batch mode and queues the submit; later updates edit `statusMsgId`. Returns false when batch mode is off. */
export async function finishImport(env: Env, userId: number, statusMsgId: number): Promise<boolean> {
  if (!batchEnabled(env)) return false;
  const id = await env.DB.prepare(
    "UPDATE imports SET status = 'submitting', status_msg_id = ?, updated_at = unixepoch() WHERE user_id = ? AND status = 'collecting' RETURNING id",
  )
    .bind(statusMsgId, userId)
    .first<string>("id");
  if (!id) return false;
  await env.JOBS.send({ type: "batch_submit", importId: id });
  return true;
}

/** Closes batch mode; collected photos continue in the normal pipeline. Returns the photo count, or null. */
export async function cancelImport(env: Env, userId: number): Promise<number | null> {
  if (!batchEnabled(env)) return null; // cancelling normally converts the whole import to full-price processing
  const id = await env.DB.prepare(
    "UPDATE imports SET status = 'cancelled', updated_at = unixepoch() WHERE user_id = ? AND status = 'collecting' RETURNING id",
  )
    .bind(userId)
    .first<string>("id");
  if (!id) return null;
  const memes = await pending(env.DB, id);
  await env.DB.prepare("UPDATE memes SET import_id = NULL WHERE import_id = ?").bind(id).run();
  await sendJobs(env, describeJobs(memes.filter((m) => m.status === "describing")));
  return memes.length;
}

/** Submits one describe batch for the import's photos (no server tools; images as signed URLs). */
export async function submitImport(env: Env, importId: string) {
  if (!batchEnabled(env)) return stopUnsubmittedImport(env, importId);
  const imp = await env.DB.prepare("SELECT * FROM imports WHERE id = ?").bind(importId).first<Import>();
  if (imp?.status !== "submitting") return;
  if (imp.submission_started) return; // another submit owns it; startup resolves interrupted ownership
  await finishDescribed(env, importId);
  const memes = await pending(env.DB, importId);
  if (memes.some((m) => m.status === "embedding")) {
    // Photos are cached in R2 by stage 1; wait until it finishes.
    await env.JOBS.send({ type: "batch_submit", importId }, { delaySeconds: 30 });
    return;
  }
  if (!memes.length) {
    await env.DB.prepare("UPDATE imports SET status = 'done', updated_at = unixepoch() WHERE id = ?").bind(importId).run();
    return progress(env, imp, "batch_empty");
  }

  const [inBatch, rest] = [memes.slice(0, BATCH_MAX), memes.slice(BATCH_MAX)];
  await sendJobs(env, describeJobs(rest));
  const tags = await topTags(env.DB, imp.user_id);
  const tier = await userTier(env.DB, imp.user_id);
  // The OpenRouter batch endpoint only supports specific models; online chat routes
  // may select another provider or a model not offered on that endpoint.
  const model = DESCRIBE_MODELS[tier];
  const requests = [];
  for (let i = 0; i < inBatch.length; i += 25) {
    requests.push(
      ...(await Promise.all(
        inBatch.slice(i, i + 25).map(async (m) => ({
          custom_id: m.id,
          body: { ...describeRequest(m, tags, [{ type: "image_url", image_url: { url: await batchImageUrl(env, m) } }]), model },
        })),
      )),
    );
  }
  const claimed = await env.DB.prepare("UPDATE imports SET submission_started=1 WHERE id=? AND status='submitting' AND submission_started=0 RETURNING id").bind(importId).first();
  if (!claimed) return;
  // The claim blocks rotation before we resolve the key. Until the POST starts,
  // a missing or unreadable key is safe to retry, not an unknown external outcome.
  let key: string;
  try {
    key = await openRouterKey(env);
  } catch (error) {
    await env.DB.prepare("UPDATE imports SET submission_started=0 WHERE id=? AND status='submitting'").bind(importId).run();
    throw error;
  }
  let batch: Batch;
  try {
    batch = await createBatch(
      key,
      {
        endpoint: "/v1/chat/completions",
        model,
        completion_window: "24h",
        callback_url: `${env.PUBLIC_URL.replace(/\/$/, "")}/batch/webhook`,
      },
      requests,
    );
  } catch (error) {
    console.error("batch submission outcome unknown", imp.id, error);
    await failUnknownSubmission(env, imp);
    return;
  }
  const attempt = imp.attempts + 1;
  await env.DB.prepare(
    "UPDATE imports SET status = 'submitted', submission_started=0, batch_id = ?, key_source = ?, attempts = ?, model = ?, updated_at = unixepoch() WHERE id = ?",
  )
    .bind(batch.id, "global", attempt, model, importId)
    .run();
  const retrying = attempt > 1;
  await progress(env, imp, retrying ? "batch_resubmitted" : "batch_submitted", { n: inBatch.length, attempt, max: MAX_ATTEMPTS });
}

/**
 * Image URL for the batch provider: a presigned R2 link to the stored file (its key ends with the file
 * extension Vertex requires); the Worker media URL without R2 API keys.
 */
async function batchImageUrl(env: Env, m: Meme) {
  if (!m.r2_file) await memeMedia(env, m, "file"); // back-fill from Telegram
  if (m.r2_file && !hasExt(m.r2_file)) {
    await rekeyStage(env, m.id);
    m.r2_file = (await getMeme(env.DB, m.id))?.r2_file ?? m.r2_file;
  }
  const presigned = m.r2_file ? await presignedR2Url(env, m.r2_file, MEDIA_TTL) : null;
  return presigned ?? signedMediaUrl(env, m, "file", MEDIA_TTL, env.MEDIA_URL ?? env.PUBLIC_URL);
}

/** Last-retry failure of a submit: the photos go to the normal pipeline. */
export async function failImport(env: Env, importId: string, error: unknown) {
  const current = await env.DB.prepare("SELECT * FROM imports WHERE id=?").bind(importId).first<Import>();
  if (current?.status !== "submitting") return;
  if (!batchEnabled(env)) return stopUnsubmittedImport(env, importId);
  if (current.submission_started) return failUnknownSubmission(env, current);
  const imp = await env.DB.prepare(
    "UPDATE imports SET status = 'failed', error = ?, updated_at = unixepoch() WHERE id = ? AND status = 'submitting' AND submission_started=0 RETURNING user_id, status_msg_id",
  )
    .bind(String(error).slice(0, 1000), importId)
    .first<Status>();
  if (!imp) return;
  const memes = await pending(env.DB, importId);
  await sendJobs(env, describeJobs(memes));
  await notify(env, imp, "batch_failed", { n: memes.length, error: errorNote(error) });
}

/** Checks all submitted imports; called by the OpenRouter webhook and by cron. */
export async function pollImports(env: Env) {
  await flushBatchContinuations(env);
  const { results } = await env.DB.prepare("SELECT * FROM imports WHERE status = 'submitted'").all<Import>();
  for (const imp of results) {
    await finishDescribed(env, imp.id);
    await pollImport(env, imp).catch((e) => console.error("batch poll failed", imp.id, e));
  }
}

/**
 * Memes of an import that already have a description (e.g. a retry after a later step failed) do not need
 * the batch: detach them and run only the last step (text embedding, ready).
 */
async function finishDescribed(env: Env, importId: string) {
  await persistDescribedContinuations(env, importId);
  await flushBatchContinuations(env);
}

async function persistDescribedContinuations(env: Env, importId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, gen FROM memes WHERE import_id = ? AND status = 'describing' AND title IS NOT NULL",
  )
    .bind(importId)
    .all<{ id: string; gen: number }>();
  for (const r of results) await env.DB.batch([
    continuation(env.DB, { type: "finish", memeId: r.id, gen: r.gen }),
    env.DB.prepare("UPDATE memes SET import_id=NULL WHERE id=? AND gen=? AND import_id=?").bind(r.id, r.gen, importId),
  ]);
}

async function pollImport(env: Env, imp: Import) {
  const db = env.DB;
  const enabled = batchEnabled(env);
  const batchId = imp.batch_id!;
  const source = imp.key_source ?? "global";
  const batch = await getBatch(env, imp.user_id, source, batchId);
  if (RUNNING.includes(batch.status)) return;
  const claimed = await db
    .prepare("UPDATE imports SET status = 'processing', updated_at = unixepoch() WHERE id = ? AND status = 'submitted' AND batch_id = ? RETURNING id")
    .bind(imp.id, batchId)
    .first();
  if (!claimed) return; // another poll took it

  try {
    const byId = new Map((batch.results ?? []).map((r) => [r.custom_id, r]));
    const saved: Meme[] = [];
    const retry: Meme[] = [];
    const blocked: Meme[] = [];
    const updates: D1PreparedStatement[] = [];
    for (const m of await pending(db, imp.id)) {
      const error = byId.get(m.id)?.error;
      if (error && isBlocked(JSON.stringify(error))) {
        blocked.push(m); // a resubmit would be blocked again
        continue;
      }
      const response = byId.get(m.id)?.response;
      const msg = (response?.body ?? response)?.choices?.[0]?.message; // OpenRouter wraps it in "body"
      try {
        updates.push(saveDescription(db, m, parseAnswer(msg?.content ?? "", msg?.refusal)[0]),
          continuation(db, { type: "finish", memeId: m.id, gen: m.gen }),
          db.prepare("UPDATE imports SET described=described+1 WHERE id=?").bind(imp.id));
        saved.push(m);
      } catch (e) {
        (isBlocked(e) ? blocked : retry).push(m); // a refusal would come again
      }
    }
    // Three statements per meme must never be split between transactions.
    for (let i = 0; i < updates.length; i += 90) await db.batch(updates.slice(i, i + 90));
    await recordBatchSpend(env, imp.user_id, imp.model ?? MODELS.describeImage, source, batch.usage, { batchId, importId: imp.id });
    // Blocked photos go online individually. Default routes omit the actual rejected model;
    // explicit custom routes still use their configured provider and model.
    for (const m of enabled ? blocked : []) await db.batch([
      continuation(db, { type: "describe", memeId: m.id, gen: m.gen, from: 1, batchModel: imp.model ?? undefined }),
      db.prepare("UPDATE memes SET import_id=NULL WHERE id=? AND gen=?").bind(m.id, m.gen),
    ]);
    const totals = (await db.prepare("SELECT described, cost FROM imports WHERE id=?").bind(imp.id).first<Import>())!;
    const { described, cost } = totals;
    await flushBatchContinuations(env);
    const reason = batchError(batch);
    const error = batch.status === "completed" && !batch.error && !(batch.results ?? []).some((r) => r.error) ? null : reason;

    if (!enabled) {
      const unresolved = retry.length + blocked.length;
      await db.batch([
        db.prepare(`UPDATE memes SET status='failed', error=?, gen=gen+1, updated_at=unixepoch()
          WHERE import_id=? AND status IN ('embedding','describing') AND title IS NULL`)
          .bind(BATCH_DISABLED_ERROR, imp.id),
        db.prepare("UPDATE imports SET status=?, error=?, updated_at=unixepoch() WHERE id=?")
          .bind(unresolved || !described ? "failed" : "done", unresolved ? error ?? BATCH_DISABLED_ERROR : error, imp.id),
      ]);
      await notify(env, imp, unresolved || !described ? "batch_stopped" : "batch_done", {
        ok: described, n: unresolved, cost: usd(cost), reason: esc(BATCH_DISABLED_ERROR),
      });
      return;
    }

    if (retry.length && imp.attempts < MAX_ATTEMPTS) {
      // Resubmit only the failed photos (they are still pending) in a new batch.
      await db.batch([
        db.prepare("UPDATE imports SET status='submitting', submission_started=0, error=?, updated_at=unixepoch() WHERE id=?").bind(error, imp.id),
        continuation(db, { type: "batch_submit", importId: imp.id }),
      ]);
      await flushBatchContinuations(env);
      return;
    }

    const fallback = retry.length <= fallbackLimit(saved.length + retry.length);
    if (fallback) {
      for (const job of describeJobs(retry)) await continuation(db, job).run();
      await flushBatchContinuations(env);
    } else {
      for (let i = 0; i < retry.length; i += 50) {
        const ids = retry.slice(i, i + 50).map((m) => m.id);
        await db.prepare(`UPDATE memes SET status = 'failed', error = ?, updated_at = unixepoch()
          WHERE import_id=? AND status IN ('embedding','describing') AND title IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
          .bind(`batch: ${reason}`.slice(0, 1000), imp.id, ...ids)
          .run();
        for (const id of ids) await push(env, imp.user_id, { t: "meme", id, status: "failed" });
      }
    }
    const status = (described || blocked.length) && fallback ? "done" : "failed";
    await db.prepare("UPDATE imports SET status = ?, described = ?, error = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(status, described, error, imp.id)
      .run();
    const key = !fallback ? "batch_stopped" : described ? "batch_done" : "batch_failed";
    await notify(env, imp, key, { ok: described, n: retry.length, cost: usd(cost), reason: esc(reason.slice(0, 300)) });
  } catch (e) {
    await db.prepare("UPDATE imports SET status = 'submitted' WHERE id = ? AND status='processing'").bind(imp.id).run();
    throw e;
  }
}
