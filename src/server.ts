import { resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { LiveSocketData } from "./live";
import { liveUser } from "./live";
import worker from "./index";
import { createEnvironment } from "./runtime/env";
import { startPolling } from "./runtime/polling";
import { createBot } from "./bot";
import { syncCommands } from "./botcommands";

// Workers' scheduler.wait is used by Telegram rate-limit code. No network policy is changed.
Object.assign(globalThis, { scheduler: { wait: (ms: number) => Bun.sleep(ms) } });

export function publicRequest(req: Request, origin: string) {
  const incoming = new URL(req.url), target = new URL(origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  // PUBLIC_URL is the sole trusted origin; never trust user-controlled Host/X-Forwarded-*.
  const headers = new Headers(req.headers);
  headers.set("Host", target.host);
  return new Request(target.href, { method: req.method, headers, body: req.body, redirect: req.redirect });
}

export function authorizedWorker(req: Request, secret: string) {
  const provided = Buffer.from(req.headers.get("Authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function staticResponse(req: Request, root = "app/dist"): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const pathname = new URL(req.url).pathname;
  // Only the root and Vite's assets are static; unknown API routes never get the SPA.
  if (pathname !== "/" && !pathname.startsWith("/assets/") && pathname !== "/favicon.ico") return null;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return new Response("Bad path", { status: 400 }); }
  const base = resolve(root), path = resolve(base, decoded === "/" ? "index.html" : `.${decoded}`);
  if (!path.startsWith(base + sep)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(path);
  if (!await file.exists()) return new Response("Not found", { status: 404 });
  return new Response(req.method === "HEAD" ? null : file, { headers: {
    "Content-Type": file.type, "Content-Length": String(file.size), "X-Content-Type-Options": "nosniff",
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  } });
}

export async function startServer() {
  const runtime = await createEnvironment(), { env, queues, jobs, db, storage } = runtime;
  const pending = new Set<Promise<unknown>>();
  const ctx = { waitUntil(p: Promise<unknown>) {
    const tracked = Promise.resolve(p).catch(e => console.error("background task", e)).finally(() => pending.delete(tracked));
    pending.add(tracked);
  }, passThroughOnException() {} } as ExecutionContext;
  let stopping = false, cron: Promise<unknown> | undefined;
  const server = Bun.serve<LiveSocketData>({
    port: Number(process.env.PORT ?? 3000), hostname: "0.0.0.0", idleTimeout: 60,
    maxRequestBodySize: 512 * 1024 * 1024,
    async fetch(original, server) {
      try {
        const path = new URL(original.url).pathname;
        if (path === "/healthz") return Response.json({ ok: !stopping }, { status: stopping ? 503 : 200 });
        if (stopping) return new Response("Shutting down", { status: 503 });
        if (path.startsWith("/internal/")) {
          if (!authorizedWorker(original, env.WORKER_SECRET)) return new Response("Unauthorized", { status: 401 });
          return await jobs.handle(original) ?? new Response("Not found", { status: 404 });
        }
        const req = publicRequest(original, env.PUBLIC_URL);
        if (path.startsWith("/app/live/")) {
          const userId = await liveUser(req, env);
          if (!userId) return new Response("Forbidden", { status: 403 });
          if (server.upgrade(original, { data: { userId } })) return;
          return new Response("Upgrade Required", { status: 426 });
        }
        return await staticResponse(req) ?? await worker.fetch(req as Parameters<typeof worker.fetch>[0], env, ctx);
      } catch (e) { console.error("request failed", e); return new Response("Internal server error", { status: 500 }); }
    },
    websocket: {
      open: ws => env.LIVE.open(ws), close: ws => env.LIVE.close(ws),
      message(ws, message) { if (message === "ping") ws.send("pong"); },
      idleTimeout: 120, maxPayloadLength: 1024, backpressureLimit: 64 * 1024, closeOnBackpressureLimit: true,
    },
  });
  queues.start(); jobs.start();
  const polling = startPolling(env, { createBot, syncCommands });
  const timer = setInterval(() => {
    if (stopping || cron) return;
    cron = (async () => {
      await storage.cleanup();
      await worker.scheduled(undefined as never, env);
    })().catch(e => console.error("scheduled task", e)).finally(() => { cron = undefined; });
  }, 15 * 60_000);
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer); env.LIVE.stop();
    const force = setTimeout(() => { console.error("Shutdown timed out; leases will recover on restart"); process.exit(1); }, 25_000);
    force.unref();
    // Poll middleware may still enqueue work: drain it before stopping consumers.
    await Promise.all([server.stop(), polling.stop()]);
    await Promise.all([queues.stop(), cron, ...pending]);
    await jobs.stop();
    // A finishing request may have registered another background task while stop() drained HTTP.
    while (pending.size) await Promise.all([...pending]);
    await storage.close(); db.close(); clearTimeout(force);
  };
  process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
  console.log(`Listening on ${server.url} (public origin ${env.PUBLIC_URL})`);
  return { ...runtime, server, stop };
}

if (import.meta.main) await startServer();
