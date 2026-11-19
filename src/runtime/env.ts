import type { Env } from "../env";
import { LiveHub } from "../live";
import { createThumbnailNamespace } from "../thumb";
import { createDatabase } from "./db";
import { createKV } from "./kv";
import { createStorage } from "./storage";
import { createVectors } from "./vectors";
import { createJobDispatcher } from "./jobs";
import { LocalQueues } from "./queue";
import worker from "../index";
import { recoverBatchImports } from "../batch";
import { validateOutboundProxyUrl } from "../outboundproxy";
import { photoProvider } from "../photoprovider";
import { batchEnabled } from "../batchmode";

export async function createEnvironment(vars: Record<string, string | undefined> = process.env) {
  validateOutboundProxyUrl(vars.OUTBOUND_PROXY_URL);
  photoProvider(vars);
  batchEnabled(vars);
  const rawPhotoWorkers = vars.PHOTO_WORKERS ?? "1";
  const photoWorkers = Number(rawPhotoWorkers);
  if (!/^\d+$/.test(rawPhotoWorkers) || !Number.isSafeInteger(photoWorkers) || photoWorkers < 1) {
    throw new Error("PHOTO_WORKERS must be a positive integer");
  }
  const telegramMode = vars.TELEGRAM_MODE ?? "polling";
  if (telegramMode !== "polling" && telegramMode !== "webhook") throw new Error("TELEGRAM_MODE must be polling or webhook");
  for (const key of ["PUBLIC_URL", "BOT_TOKEN", "ENCRYPTION_KEY", "WORKER_SECRET", "ADMIN_ID", ...(telegramMode === "webhook" ? ["WEBHOOK_SECRET", "TG_CLIENT_SECRET"] : [])]) {
    if (!vars[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  const publicUrl = new URL(vars.PUBLIC_URL!);
  if (!/^https?:$/.test(publicUrl.protocol) || publicUrl.pathname !== "/" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an HTTP(S) origin without a path");
  }
  const db = await createDatabase(vars.DB_PATH ?? "/data/app.sqlite", vars.MIGRATIONS_DIR ?? "migrations");
  const storage = createStorage(vars.MEDIA_ROOT ?? "/data/media");
  await storage.cleanup();
  const localVars = Object.fromEntries(Object.entries(vars).filter(([key]) => !key.startsWith("R2_") && key !== "MEDIA_URL"));
  const env = {
    ...localVars, TELEGRAM_MODE: telegramMode, WEBHOOK_SECRET: vars.WEBHOOK_SECRET ?? "", TG_CLIENT_SECRET: vars.TG_CLIENT_SECRET ?? "",
    PUBLIC_URL: publicUrl.origin, MEDIA_URL: publicUrl.origin, INTERNAL_URL: vars.INTERNAL_URL ?? "http://app:3000",
    THUMB_URL: vars.THUMB_URL ?? "http://thumb:8080", SELF_HOSTED: vars.SELF_HOSTED ?? "1",
    OPENROUTER_API_KEY: vars.OPENROUTER_API_KEY ?? "", SCRAPER_URL: vars.SCRAPER_URL ?? "http://scraper:8080",
    SCRAPER_API_KEY: vars.SCRAPER_API_KEY ?? "", R2_BUCKET: "media",
    DB: db, OAUTH_KV: createKV(db), MEDIA: storage,
    VECTORS: createVectors(db), LIVE: new LiveHub(),
  } as unknown as Env;
  const queues = new LocalQueues(db.sqlite, async batch => { await worker.queue(batch as MessageBatch<import("../queue").Job>, env); }, undefined, undefined, photoWorkers);
  const jobs = createJobDispatcher(db, env);
  Object.assign(env, {
    JOBS: queues.binding("memesave-jobs"), UPLOADS: queues.binding("memesave-tgupload"),
    ZIP: jobs.ZIP, EXPORT: jobs.EXPORT, ANALYZE: jobs.ANALYZE, THUMB: createThumbnailNamespace(env),
  });
  await recoverBatchImports(env);
  return { env, db, storage, queues, jobs };
}
