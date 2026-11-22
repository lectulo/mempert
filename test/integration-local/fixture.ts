import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "../../src/runtime/db";
import { createKV } from "../../src/runtime/kv";
import { createStorage } from "../../src/runtime/storage";
import { createVectors } from "../../src/runtime/vectors";
import type { Env } from "../../src/env";
import type { Meme } from "../../src/db";
import { saveAIConfig } from "../../src/aimodels";

export async function providerKey(env: Env, id: "openrouter", key: string) {
  const error = await saveAIConfig(env, { action: "provider", id, name: "OpenRouter", key });
  if (error) throw new Error(error);
}

export async function createCompatibleProvider(env: Env, id: string, baseUrl: string, key: string) {
  const error = await saveAIConfig(env, { action: "provider_create", id, name: "Fixture Compatible API", baseUrl, key });
  if (error) throw new Error(error);
}

// Existing test/batch.test.ts uses structural Env casts and SQL fixtures;
// keep that pattern, but replace all data bindings with the real local stores.
export async function fixture() {
  const base = join(import.meta.dir, ".scratch");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "acceptance-"));
  const migrations = join(import.meta.dir, "../../migrations");
  let db = await createDatabase(join(root, "db.sqlite"), migrations);
  let storage = createStorage(join(root, "files"));
  const jobs: unknown[] = [];
  const queue = {
    send: async (body: unknown) => { jobs.push(body); },
    sendBatch: async (messages: { body: unknown }[]) => { jobs.push(...messages.map(m => m.body)); },
  };
  const env = {
    DB: db, MEDIA: storage, VECTORS: createVectors(db, 1536), OAUTH_KV: createKV(db),
    JOBS: queue, UPLOADS: queue, PUBLIC_URL: "https://local.invalid", ENCRYPTION_KEY: "acceptance-only",
    BOT_TOKEN: "1:test", SELF_HOSTED: "true",
  } as unknown as Env;
  return {
    env, jobs,
    get db() { return db; },
    async reopen() {
      storage.close(); db.close();
      db = await createDatabase(join(root, "db.sqlite"), migrations);
      storage = createStorage(join(root, "files"));
      Object.assign(env, { DB: db, MEDIA: storage, VECTORS: createVectors(db, 1536), OAUTH_KV: createKV(db) });
    },
    async meme(id: string, user: number, title = "shared acceptance otter") {
      await env.DB.prepare("INSERT OR IGNORE INTO users (id, role) VALUES (?, 'paid')").bind(user).run();
      await env.DB.prepare(`INSERT INTO memes (id,user_id,kind,file_id,file_unique_id,status,title,mime,r2_file,r2_preview)
        VALUES (?,?,'photo','',?,'ready',?,'image/jpeg',?,?)`)
        .bind(id, user, `r2:${id}`, title, `u/${user}/${id}.jpg`, `u/${user}/${id}.preview.jpg`).run();
      await env.MEDIA.put(`u/${user}/${id}.jpg`, new Uint8Array([255,216,0,1,2,3,4,255,217]), { httpMetadata: { contentType: "image/jpeg" } });
      await env.MEDIA.put(`u/${user}/${id}.preview.jpg`, new Uint8Array([255,216,99,255,217]), { httpMetadata: { contentType: "image/jpeg" } });
      return (await env.DB.prepare("SELECT * FROM memes WHERE id = ?").bind(id).first<Meme>())!;
    },
    close() { storage.close(); db.close(); rmSync(root, { recursive: true }); },
  };
}

export function vector(axis = 0) {
  const values = Array(1536).fill(0); values[axis] = 1; return values;
}
