import { test, expect } from "bun:test";
import { resolve } from "node:path";

test("origin canonicalization cannot be bypassed with a scheme-relative pathname", async () => {
  const modulePath = "../../dist/server.js";
  const { publicRequest } = await import(modulePath);
  const req = publicRequest(new Request("http://internal:3000//evil.invalid/path?q=1"), "https://public.example");
  expect(req.url).toBe("https://public.example//evil.invalid/path?q=1");
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
