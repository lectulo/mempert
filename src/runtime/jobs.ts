import type { LocalDatabase } from "./db";
import type { Env } from "../env";
import type { JobNamespace } from "../job";
import { flushJobContinuations } from "../job";

type Kind = "zip" | "export" | "analyze";
interface Row {
  name: string; kind: Kind; job_id: string; env: string; state: string;
  attempts: number; lease: string | null; lease_until: number; deadline: number; error: string | null;
}
interface Options {
  now?: () => number;
  leaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  callback?: (kind: Kind, req: Request) => Promise<Response>;
  fail?: (kind: Kind, id: string, error: string) => Promise<void>;
}

/** One application process owns this dispatcher. Call sweep every 15s, including without live workers. */
export function createJobDispatcher(database: LocalDatabase, env: Env, options: Options = {}) {
  const db = database.sqlite;
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 120_000;
  const timeoutMs = options.timeoutMs ?? 4 * 3600_000;
  const maxAttempts = options.maxAttempts ?? 4;
  db.exec(`CREATE TABLE IF NOT EXISTS worker_jobs (
    name TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT NOT NULL, env TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
    lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL,
    error TEXT, PRIMARY KEY(kind, name)
  );`);
  // Serializing transitions with callbacks fences asynchronous side effects too. Concurrency is 1.
  let pending: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.catch(() => {}).then(fn);
    pending = result;
    return result;
  }
  const get = (kind: string, name: string) => db.query<Row, [string, string]>("SELECT * FROM worker_jobs WHERE kind = ? AND name = ?").get(kind, name);
  const callback = options.callback ?? (async (kind, req) => {
    if (kind === "zip") return (await import("../zip")).handleZipCallback(req, env);
    if (kind === "export") return (await import("../export")).handleExport(req, env);
    return (await import("../analysis")).handleAnalysis(req, env);
  });
  const fail = options.fail ?? (async (kind, id, error) => {
    if (kind === "zip") return (await import("../zip")).failZip(env, id, error);
    if (kind === "export") return (await import("../export")).failExport(env, id, error);
    return (await import("../analysis")).failAnalysis(env, id, error);
  });
  async function reject(row: Row, error: string) {
    db.query("UPDATE worker_jobs SET state = 'failing', lease = NULL, error = ? WHERE kind = ? AND name = ?").run(error, row.kind, row.name);
    await fail(row.kind, row.job_id, error);
    db.query("UPDATE worker_jobs SET state = 'failed' WHERE kind = ? AND name = ?").run(row.kind, row.name);
  }
  async function retry(row: Row, error: string) {
    if (now() >= row.deadline || row.attempts >= maxAttempts) return reject(row, now() >= row.deadline ? "job timeout (4h)" : error);
    db.query("UPDATE worker_jobs SET state = 'queued', lease = NULL, lease_until = 0, error = ? WHERE kind = ? AND name = ?").run(error, row.kind, row.name);
  }
  async function sweepUnlocked() {
    if (!options.callback) {
      await (await import("../zip")).recoverZipItems(env);
      // Business completion may have committed immediately before application death.
      for (const [kind, table] of [["zip", "zip_imports"], ["export", "exports"], ["analyze", "analyses"]] as const) {
        db.query(`UPDATE worker_jobs SET state = 'done', lease = NULL WHERE kind = ? AND state IN ('queued','running','failing')
          AND job_id IN (SELECT id FROM ${table} WHERE status = 'done')`).run(kind);
        const orphans = db.query<{id: string}, []>(`SELECT id FROM ${table} b WHERE status = 'running' AND updated_at < unixepoch() - 60
          AND NOT EXISTS (SELECT 1 FROM worker_jobs j WHERE j.kind = '${kind}' AND j.job_id = b.id)`).all();
        for (const row of orphans) await fail(kind, row.id, "application interrupted before job was queued");
      }
      await flushJobContinuations(env);
    }
    const rows = db.query<Row, [number, number]>("SELECT * FROM worker_jobs WHERE state = 'failing' OR (state IN ('queued', 'running') AND ((deadline > 0 AND deadline <= ?) OR (state = 'running' AND lease_until <= ?)))").all(now(), now());
    for (const row of rows) {
      if (row.state === "failing") await reject(row, row.error ?? "worker failed");
      else if (row.deadline <= now()) await reject(row, "job timeout (4h)");
      else await retry(row, "worker lease expired");
    }
  }
  function namespace(kind: Kind): JobNamespace {
    return {
      idFromName: (name) => name,
      get: (name) => ({
        run: (id, vars) => serial(async () => {
          db.query("INSERT OR IGNORE INTO worker_jobs (name, kind, job_id, env, deadline) VALUES (?, ?, ?, ?, 0)").run(name, kind, id, JSON.stringify(vars));
        }),
        purge: () => serial(async () => {
          const row = get(kind, name);
          if (row && !["done", "failed"].includes(row.state)) return -1;
          return db.query("DELETE FROM worker_jobs WHERE kind = ? AND name = ?").run(kind, name).changes;
        }),
      }),
    };
  }
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  async function handleWorkerRequest(req: Request): Promise<Response> {
    if (!env.WORKER_SECRET || req.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const [, internal, jobs, kind, encodedName, action, ...rest] = url.pathname.split("/");
    if (internal !== "internal" || jobs !== "jobs" || !["zip", "export", "analyze"].includes(kind)) return json({ error: "not found" }, 404);
    // Renewal must not wait behind a long business callback. Handover still uses serial().
    if (action === "heartbeat" && req.method === "POST") {
      let name: string;
      try { name = decodeURIComponent(encodedName); } catch { return json({ error: "bad name" }, 400); }
      const row = get(kind, name);
      if (!row || row.state !== "running" || row.lease !== req.headers.get("X-Job-Lease") || row.lease_until <= now() || row.deadline <= now()) return json({ error: "stale lease" }, 409);
      db.query("UPDATE worker_jobs SET lease_until = ? WHERE kind = ? AND name = ? AND lease = ?").run(Math.min(now() + leaseMs, row.deadline), kind, name, row.lease);
      return json({ ok: true });
    }
    return serial(async () => {
      if (encodedName === "claim" && req.method === "POST") {
        await sweepUnlocked();
        // Global concurrency=1, even if multiple launchers accidentally start.
        if (db.query("SELECT 1 FROM worker_jobs WHERE state = 'running' LIMIT 1").get()) return new Response(null, { status: 204 });
        const row = db.query<Row, [string]>("SELECT * FROM worker_jobs WHERE kind = ? AND state = 'queued' ORDER BY deadline LIMIT 1").get(kind);
        if (!row) return new Response(null, { status: 204 });
        const lease = crypto.randomUUID();
        row.deadline ||= now() + timeoutMs;
        db.query("UPDATE worker_jobs SET state = 'running', attempts = attempts + 1, lease = ?, lease_until = ?, deadline = ? WHERE kind = ? AND name = ?").run(lease, Math.min(now() + leaseMs, row.deadline), row.deadline, kind, row.name);
        const base = `${env.INTERNAL_URL.replace(/\/$/, "")}/internal/jobs/${kind}/${encodeURIComponent(row.name)}`;
        const vars = JSON.parse(row.env) as Record<string, string>;
        // The child gets only its fenced callback URL/token, never the business token.
        vars.API_URL = `${base}/callback`;
        if (vars.ZIP_URL) vars.ZIP_URL = `${base}/callback/file`;
        vars.TOKEN = lease;
        return json({ name: row.name, lease, env: vars, deadline: row.deadline, heartbeatMs: Math.floor(leaseMs / 3) });
      }
      let name: string;
      try { name = decodeURIComponent(encodedName ?? ""); } catch { return json({ error: "bad name" }, 400); }
      const row = get(kind, name);
      const lease = req.headers.get("X-Job-Lease");
      if (!row || row.state !== "running" || row.lease !== lease || row.lease_until <= now() || row.deadline <= now()) return json({ error: "stale lease" }, 409);
      if (action === "heartbeat" && req.method === "POST") {
        db.query("UPDATE worker_jobs SET lease_until = ? WHERE kind = ? AND name = ?").run(Math.min(now() + leaseMs, row.deadline), kind, name);
        return json({ ok: true });
      }
      if (action === "finish" && req.method === "POST") {
        const body = await req.json() as { error?: string };
        await retry(row, String(body.error ?? row.error ?? "worker exited without done callback").slice(0, 1000));
        return json({ ok: true });
      }
      if (action !== "callback") return json({ error: "not found" }, 404);
      if (rest[0] === "fail") {
        const body = await req.json() as { error?: string };
        db.query("UPDATE worker_jobs SET error = ? WHERE kind = ? AND name = ?").run(String(body.error ?? "worker failed").slice(0, 1000), kind, name);
        return json({ ok: true });
      }
      const vars = JSON.parse(row.env) as Record<string, string>;
      const target = new URL(`${vars.API_URL}/${rest.join("/")}${url.search}`);
      const headers = new Headers(req.headers);
      headers.set("Authorization", `Bearer ${vars.TOKEN}`);
      headers.delete("X-Job-Lease");
      const forwarded = new Request(target.toString(), { method: req.method, headers, body: req.body, duplex: "half" } as RequestInit);
      const response = await callback(row.kind, forwarded);
      if (rest[0] === "done" && response.ok) db.query("UPDATE worker_jobs SET state = 'done', lease = NULL WHERE kind = ? AND name = ?").run(kind, name);
      return response;
    });
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    ZIP: namespace("zip"), EXPORT: namespace("export"), ANALYZE: namespace("analyze"),
    handle(req: Request): Promise<Response | null> {
      if (!new URL(req.url).pathname.startsWith("/internal/jobs/")) return Promise.resolve(null);
      return handleWorkerRequest(req);
    },
    sweep: () => serial(sweepUnlocked),
    start() {
      if (!timer) timer = setInterval(() => { void serial(sweepUnlocked).catch(console.error); }, 15_000);
      void serial(sweepUnlocked).catch(console.error);
    },
    async stop() { clearInterval(timer); timer = undefined; await pending.catch(() => {}); },
  };
}
