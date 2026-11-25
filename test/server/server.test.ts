import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { signedMediaUrl, sign } from "../../src/media";

test("origin canonicalization cannot be bypassed with a scheme-relative pathname", async () => {
  const modulePath = "../../dist/server.js";
  const { publicRequest } = await import(modulePath);
  const req = publicRequest(new Request("http://internal:3000//evil.invalid/path?q=1"), "https://public.example");
  expect(req.url).toBe("https://public.example//evil.invalid/path?q=1");
});

test("the signed media route accepts HEAD with GET status and no body", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "mempert-media-head-"));
  const modulePath = "../../dist/server.js";
  const { startServer } = await import(modulePath) as typeof import("../../src/server");
  const vars = {
    PORT: "0", DB_PATH: ":memory:", MEDIA_ROOT: root, PUBLIC_URL: "http://localhost:3000",
    MEDIA_URL: "https://media.example", TELEGRAM_MODE: "webhook", BOT_TOKEN: "1:fake", WEBHOOK_SECRET: "fake",
    ENCRYPTION_KEY: "fake", TG_CLIENT_SECRET: "fake", WORKER_SECRET: "private", ADMIN_ID: "1",
  };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    runtime = await startServer();
    const { db, env, server, storage } = runtime;
    db.sqlite.exec(`INSERT INTO users (id, role) VALUES (1, 'admin');
      INSERT INTO memes (id,user_id,kind,file_id,file_unique_id,status,mime,r2_file)
      VALUES ('head',1,'photo','','head','ready','image/jpeg','head.jpg');`);
    await storage.put("head.jpg", new Uint8Array(9), { httpMetadata: { contentType: "image/jpeg" } });
    const meme = { id: "head", kind: "photo", mime: "image/jpeg", r2_file: "head.jpg", r2_preview: null, file_id: "", preview_file_id: null } as const;
    const url = new URL(await signedMediaUrl(env, meme, "file", 60, env.MEDIA_URL));
    const expired = Math.floor(Date.now() / 1000) - 10;
    const expiredQuery = `?e=${expired}&s=${await sign(env, `media|head|file|${expired}`)}`;
    const missing = await signedMediaUrl(env, { ...meme, id: "missing" }, "file", 60, env.MEDIA_URL);
    for (const [path, status, range] of [
      [url.pathname + url.search, 200, undefined], [url.pathname + url.search, 206, "bytes=2-5"],
      [url.pathname + url.search, 416, "bytes=20-30"], [new URL(missing).pathname + new URL(missing).search, 404, undefined],
      [url.pathname, 404, undefined], [url.pathname + expiredQuery, 404, undefined],
    ] as const) {
      const headers = range ? { Range: range } : undefined;
      const get = await fetch(new URL(path, server.url), { headers });
      const head = await fetch(new URL(path, server.url), { method: "HEAD", headers });
      expect(get.status).toBe(status);
      expect(head.status).toBe(get.status);
      for (const header of ["content-range", "accept-ranges", "cache-control"]) {
        expect(head.headers.get(header)).toBe(get.headers.get(header));
      }
      if (status < 400) {
        expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
        expect(head.headers.get("content-type")).toBe("image/jpeg");
      }
      expect(await head.text()).toBe("");
      await get.arrayBuffer();
    }
  } finally {
    await runtime?.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true });
  }
});

test("built server boots offline, uses configured origin, and protects internal routes", async () => {
  const state = resolve(`.compat-spike/server-test-${crypto.randomUUID()}`);
  const child = Bun.spawn([process.execPath, "dist/server.js"], { env: {
    ...process.env, PORT: "0", DB_PATH: `${state}/app.sqlite`, MEDIA_ROOT: `${state}/media`,
    PUBLIC_URL: "https://public.example", TELEGRAM_MODE: "webhook", BOT_TOKEN: "1:fake", WEBHOOK_SECRET: "fake",
    ENCRYPTION_KEY: "fake", TG_CLIENT_SECRET: "fake", WORKER_SECRET: "private", ADMIN_ID: "1",
  }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    let text = "", local: string | undefined;
    while (!local) {
      const r = await reader.read(); if (r.done) throw new Error(`server exited: ${text}`);
      text += new TextDecoder().decode(r.value);
      local = /Listening on (http:\/\/[^ ]+)/.exec(text)?.[1];
    }
    expect((await fetch(new URL("/healthz", local))).status).toBe(200);
    expect((await fetch(new URL("/internal/jobs/zip/claim", local), { method: "POST" })).status).toBe(401);
    expect((await fetch(new URL("/app/live/1?e=9999999999&s=bad", local))).status).toBe(403);
    const metadata = await (await fetch(new URL("/.well-known/oauth-authorization-server", local), { headers: { "X-Forwarded-Host": "evil.invalid" } })).json() as Record<string, unknown>;
    expect(metadata.issuer).toBe("https://public.example");
    expect(metadata.client_id_metadata_document_supported).not.toBe(true);
    const registration = await fetch(new URL("/oauth/register", local), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "smoke", redirect_uris: ["http://localhost:8080/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    expect(registration.status).toBe(201);
    const cid = (await registration.json() as {client_id:string}).client_id;
    const cimd = await fetch(new URL(`/oauth/authorize?client_id=${encodeURIComponent("https://127.0.0.1/private.json")}&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`, local));
    expect(cimd.status).toBe(400);
    expect(cid.length).toBeGreaterThan(0);
    const exp = Math.floor(Date.now() / 1000) + 60;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("media|fake"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
    const sig = Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`live|1|${exp}`))).toString("base64url");
    const wsUrl = new URL(`/app/live/1?e=${exp}&s=${sig}`, local); wsUrl.protocol="ws:";
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((ok, fail) => { ws.onopen=()=>ok(); ws.onerror=()=>fail(new Error("WebSocket failed")); });
    const pong = new Promise<string>(ok => { ws.onmessage=e=>ok(String(e.data)); });
    ws.send("ping"); expect(await pong).toBe("pong"); ws.close();
    expect((await fetch(new URL("/", local))).status).toBe(200);
    expect((await fetch(new URL("/webhook", local), { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(new URL("/app/api/not-found", local))).headers.get("Content-Type")).not.toContain("text/html");
  } finally { child.kill("SIGTERM"); expect(await child.exited).toBe(0); }
}, 15_000);
