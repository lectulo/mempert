/** Local replacement for named one-shot container bindings. */
export interface JobStub {
  run(id: string, envVars: Record<string, string>): Promise<void>;
  purge(): Promise<number>;
}
export interface JobNamespace {
  idFromName(name: string): string;
  get(id: string): JobStub;
}

import type { Env } from "./env";
import type { LocalDatabase } from "./runtime/db";
import type { Job } from "./queue";

/** Local-only durable continuations; network work is deliberately outside SQLite transactions. */
export function jobDatabase(env: Env) {
  const sqlite = (env.DB as unknown as LocalDatabase).sqlite;
  if (!sqlite) return undefined;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS worker_continuations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_continuations_sent (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS zip_pending_items (zip_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS zip_item_members (zip_id TEXT NOT NULL, meme_id TEXT NOT NULL, PRIMARY KEY(zip_id,meme_id));`);
  return sqlite;
}

export async function continueJob(env: Env, id: string, body: Job) {
  const db = jobDatabase(env);
  if (!db) { await env.JOBS.send(body); return; }
  if (db.query("SELECT 1 FROM worker_continuations_sent WHERE id = ?").get(id)) return;
  db.query("INSERT OR IGNORE INTO worker_continuations VALUES (?, ?)").run(id, JSON.stringify(body));
}

export async function flushJobContinuations(env: Env) {
  const db = jobDatabase(env);
  if (!db) return;
  for (const row of db.query<{ id: string; body: string }, []>("SELECT * FROM worker_continuations").all()) {
    const body = JSON.parse(row.body) as Job;
    if (row.id.startsWith("analysis:") && !db.query("SELECT 1 FROM analyses WHERE id = ? AND status = 'done'").get(row.id.split(":")[1])) continue;
    if (row.id.endsWith(":batch") && !db.query("SELECT 1 FROM zip_imports WHERE id = ? AND status IN ('done','failed')").get(row.id.split(":")[1])) continue;
    await env.JOBS.send(body);
    db.transaction(() => {
      db.query("INSERT OR IGNORE INTO worker_continuations_sent VALUES (?)").run(row.id);
      db.query("DELETE FROM worker_continuations WHERE id = ?").run(row.id);
    })();
  }
}

/** Notifications are best-effort after durable completion, never part of worker success. */
export function notifyJob(work: () => Promise<unknown>) { void work().catch(console.error); }
