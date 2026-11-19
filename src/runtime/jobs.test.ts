import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { LocalDatabase } from "./db";
import type { Env } from "../env";
import { createJobDispatcher } from "./jobs";

const databases: Database[] = [];
type Claimed = { lease: string; env: Record<string, string> };
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const sqlite = new Database(":memory:"); databases.push(sqlite);
  let time = 1000;
  const failures: string[] = [];
  const callbacks: string[] = [];
  const env = { INTERNAL_URL: "http://app:3000", WORKER_SECRET: "secret" } as Env;
  const options = {
    now: () => time, leaseMs: 100, timeoutMs: 1000, maxAttempts: 2,
    fail: async (_kind: string, _id: string, error: string) => { failures.push(error); },
    callback: async (_kind: string, req: Request) => { callbacks.push(req.url); return Response.json({ ok: true }); },
  };
  const create = () => createJobDispatcher({ sqlite } as LocalDatabase, env, options);
  const dispatcher = create();
  async function request(path: string, lease?: string, body: unknown = {}, secret = "secret") {
    return dispatcher.handle(new Request(`http://app:3000/internal/jobs/zip/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${secret}`, "X-Job-Lease": lease ?? "", "Content-Type": "application/json" }, body: JSON.stringify(body),
    })) as Promise<Response>;
  }
  const enqueue = () => dispatcher.ZIP.get("job").run("business", { API_URL: "http://app:3000/zip/business", TOKEN: "business-token", ZIP_URL: "http://app:3000/zip/business/file" });
  return { sqlite, dispatcher, request, enqueue, create, failures, callbacks, advance: (ms: number) => { time += ms; } };
}

describe("persistent workers", () => {
  test("auth, idempotency, global concurrency and success", async () => {
    const f = fixture(); await f.enqueue(); await f.enqueue();
    expect((await f.request("claim", undefined, {}, "wrong")).status).toBe(401);
    const job = await (await f.request("claim")).json() as Claimed;
    expect(job.env.TOKEN).toBe(job.lease);
    expect(job.env.API_URL).toContain("/internal/jobs/zip/job/callback");
    expect((await f.request("claim")).status).toBe(204);
    expect(await f.dispatcher.ZIP.get("job").purge()).toBe(-1);
    expect((await f.request("job/callback/done", job.lease)).status).toBe(200);
    expect(f.callbacks).toEqual(["http://app:3000/zip/business/done"]);
    expect((await f.request("job/finish", job.lease)).status).toBe(409);
    expect(await f.dispatcher.ZIP.get("job").purge()).toBe(1);
  });
  test("worker death, app restart, fencing and retry exhaustion", async () => {
    const f = fixture(); await f.enqueue();
    const first = await (await f.request("claim")).json() as Claimed;
    f.advance(101);
    await f.create().sweep(); // same durable DB, new dispatcher
    const second = await (await f.request("claim")).json() as Claimed;
    expect(second.lease).not.toBe(first.lease);
    expect((await f.request("job/callback/done", first.lease)).status).toBe(409);
    expect((await f.request("job/heartbeat", first.lease)).status).toBe(409);
    await f.request("job/callback/fail", second.lease, { error: "broken" });
    expect(f.failures).toEqual([]);
    await f.request("job/finish", second.lease, { error: "broken" });
    expect(f.failures).toEqual(["broken"]);
    expect((await f.request("claim")).status).toBe(204);
  });
  test("heartbeats extend lease but not hard execution timeout", async () => {
    const f = fixture(); await f.enqueue();
    const job = await (await f.request("claim")).json() as Claimed;
    f.advance(80); expect((await f.request("job/heartbeat", job.lease)).status).toBe(200);
    f.advance(40); expect((await f.request("job/heartbeat", job.lease)).status).toBe(200);
    f.advance(1000); await f.dispatcher.sweep();
    expect(f.failures).toEqual(["job timeout (4h)"]);
    expect((await f.request("job/callback/done", job.lease)).status).toBe(409);
  });
  test("failure callback is retried after crash/error", async () => {
    const f = fixture(); await f.enqueue(); await f.request("claim"); f.advance(1001);
    let attempts = 0;
    const d = createJobDispatcher({ sqlite: f.sqlite } as LocalDatabase, {} as Env, {
      now: () => 2001,
      callback: async () => Response.json({ok:true}),
      fail: async () => { if (++attempts === 1) throw new Error("temporary"); },
    });
    await expect(d.sweep()).rejects.toThrow("temporary");
    await d.sweep(); expect(attempts).toBe(2);
    expect(await d.ZIP.get("job").purge()).toBe(1);
  });
  test("long callback does not block renewal; sweep cannot hand over its lease", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const deferred = new Promise<void>(resolve => { release = resolve; });
    const d = createJobDispatcher({ sqlite: f.sqlite } as LocalDatabase, { INTERNAL_URL: "http://app", WORKER_SECRET: "secret" } as Env, {
      now: () => clock, leaseMs: 100, timeoutMs: 1000,
      callback: async () => { entered(); await deferred; return Response.json({ok:true}); },
    });
    let clock = 1000;
    await d.ZIP.get("slow").run("slow", {API_URL:"http://app/zip/slow",TOKEN:"original"});
    const req = (path: string, lease = "") => d.handle(new Request(`http://app/internal/jobs/zip/${path}`, {method:"POST",headers:{Authorization:"Bearer secret","X-Job-Lease":lease},body:"{}"})) as Promise<Response>;
    const job = await (await req("claim")).json() as Claimed;
    const work = req("slow/callback/items",job.lease);
    await started;
    clock += 80;
    expect((await req("slow/heartbeat",job.lease)).status).toBe(200);
    const sweep = d.sweep();
    clock += 40;
    expect((await req("slow/heartbeat",job.lease)).status).toBe(200);
    let stopped = false;
    const stop = d.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await work; await sweep; await stop;
    expect((await req("claim")).status).toBe(204);
  });
  test("queued waiting time is not execution time; deadline survives retries", async () => {
    const f = fixture(); await f.enqueue(); f.advance(50_000);
    await f.dispatcher.sweep(); expect(f.failures).toEqual([]);
    const first = await (await f.request("claim")).json() as Claimed & {deadline:number};
    expect(first.deadline).toBe(52_000);
    f.advance(101); await f.dispatcher.sweep();
    const second = await (await f.request("claim")).json() as Claimed & {deadline:number};
    expect(second.deadline).toBe(first.deadline);
  });
});
