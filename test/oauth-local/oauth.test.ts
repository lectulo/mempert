import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "../../src/runtime/db";
import { createKV } from "../../src/runtime/kv";
import type { Env } from "../../src/env";


const ORIGIN = "https://oauth-local.invalid";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "http://localhost:8942/callback";
const VERSION = "2026-07-28";
const SECRET = "offline-oauth-fake-secret";
const ctx = { waitUntil: (_promise: Promise<unknown>) => {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("offline discovery → DCR → signed session/consent → PKCE → read-only MCP → durable refresh → revoke", async () => {
  const scratch = join(import.meta.dir, ".scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "oauth-"));
  // Isolated bundle, never scripts/build-server.ts or shared dist output.
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "handlers.ts")], outdir: root, target: "bun", plugins: [{ name: "oauth-worker-entrypoint", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: join(import.meta.dir, "../../src/runtime/worker-shim.ts") }));
  } }] });
  if (!built.success) throw new Error(String(built.logs));
  const { OAuthProvider, oauthOptions, handleAuthorize, handleApp } = await import(join(root, "handlers.js")) as typeof import("./handlers");
  let db = createDatabase(join(root, "oauth.sqlite"), join(import.meta.dir, "../../migrations"));
  const env = { DB: db, OAUTH_KV: createKV(db), PUBLIC_URL: ORIGIN, ENCRYPTION_KEY: SECRET, BOT_TOKEN: "1:fake", SELF_HOSTED: "1" } as unknown as Env;
  const makeProvider = () => new OAuthProvider(oauthOptions(env, {
    async fetch(req, env, ctx) {
      if (new URL(req.url).pathname === "/oauth/authorize") return handleAuthorize(req, env);
      return (await handleApp(req, env, ctx)) ?? new Response("Not found", { status: 404 });
    },
  }));
  let provider = makeProvider();
  const call = (path: string, init?: RequestInit) => provider.fetch(new Request(new URL(path, ORIGIN).href, init) as never, env, ctx);
  const post = (path: string, body: URLSearchParams) => call(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  let rpcId = 0;
  const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) => {
    const response = await call("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": VERSION, "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": VERSION, "io.modelcontextprotocol/clientInfo": { name: "offline", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  const originalFetch = globalThis.fetch;
  const externalRequests: string[] = [];
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0]) => {
    externalRequests.push(String(input));
    throw new Error(`Network forbidden in OAuth integration: ${input}`);
  }, { preconnect: originalFetch.preconnect });
  try {
    await db.prepare("INSERT INTO users (id, role, username) VALUES (901, 'user', 'offline'), (902, 'user', 'other')").run();
    await db.prepare(`INSERT INTO memes (id,user_id,kind,file_id,file_unique_id,status,title) VALUES
      ('own',901,'photo','fake','own-unique','ready','offline cat'),
      ('other',902,'photo','fake','other-unique','ready','other cat')`).run();

    const discovery = await call("/.well-known/oauth-authorization-server");
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as any;
    expect(metadata.issuer).toBe(ORIGIN);
    expect(metadata.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(metadata.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(metadata.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.client_id_metadata_document_supported).not.toBe(true);
    expect((await (await call("/.well-known/oauth-protected-resource/mcp")).json() as any).resource).toBe(RESOURCE);
    const unauthenticated = await call("/mcp", { method: "POST", body: "{}" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")).toContain("resource_metadata");

    const registration = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Offline <client>", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    expect(registration.status).toBe(201);
    const { client_id } = await registration.json() as { client_id: string };
    expect(client_id).toBeTruthy();
    const verifier = "offline-local-pkce-".repeat(4);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "offline-state", scope: "memes:read memes:write", resource: RESOURCE });
    const path = `/oauth/authorize?${query}`;
    const anonymous = await call(path);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("Location")).toBe(`${ORIGIN}/auth/telegram?next=${encodeURIComponent(path)}`);
    const cimd = new URLSearchParams(query); cimd.set("client_id", "https://not-fetched.invalid/client.json");
    expect((await call(`/oauth/authorize?${cimd}`)).status).toBe(400);

    // Generate the documented Telegram web-session format independently, with real HMAC verification.
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`media|${SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`session|901|${expiry}`))).toString("base64url");
    const session = `session=901.${expiry}.${signature}`;
    expect((await call(path, { headers: { Cookie: `${session}invalid` } })).status).toBe(302);
    const page = await call(path, { headers: { Cookie: session } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Offline &lt;client&gt;");
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
    const consentCookies = page.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect(consentCookies).toBeTruthy();
    const approve = (cookie: string) => call(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision: "allow" }) });
    // Knowing the opaque form handle without its browser binding must not grant access.
    expect((await approve(session)).status).toBe(400);
    const approved = await approve(`${session}; ${consentCookies}`);
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("Location")!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("offline-state");
    expect(callback.searchParams.get("iss")).toBe(ORIGIN);
    const exchange = (code_verifier: string) => post("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", client_id, redirect_uri: REDIRECT, code: callback.searchParams.get("code")!, code_verifier, resource: RESOURCE }));
    expect((await exchange("wrong-verifier-".repeat(5))).status).toBe(400);
    const tokenResponse = await exchange(verifier);
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as any;
    expect(token.access_token).toBeTruthy(); expect(token.refresh_token).toBeTruthy();
    expect(token.scope).toBe("memes:read");

    const tools = (await rpc(token.access_token, "tools/list")).result.tools.map((tool: any) => tool.name);
    expect(tools).toContain("list_memes"); expect(tools).not.toContain("delete_memes"); expect(tools).not.toContain("upload_meme");
    const listed = (await rpc(token.access_token, "tools/call", { name: "list_memes", arguments: {} })).result;
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent.items.map((item: any) => item.id)).toEqual(["own"]);
    const denied = await rpc(token.access_token, "tools/call", { name: "delete_memes", arguments: { ids: ["own"] } });
    expect(Boolean(denied.error || denied.result?.isError)).toBe(true);
    expect(await db.prepare("SELECT id FROM memes WHERE id='own'").first()).not.toBeNull();

    db.close();
    db = createDatabase(join(root, "oauth.sqlite"), join(import.meta.dir, "../../migrations"));
    Object.assign(env, { DB: db, OAUTH_KV: createKV(db) });
    provider = makeProvider();
    const refresh = (refresh_token: string) => post("/oauth/token", new URLSearchParams({ grant_type: "refresh_token", client_id, refresh_token, resource: RESOURCE }));
    const refreshedResponse = await refresh(token.refresh_token);
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json() as any;
    expect(refreshed.access_token).toBeTruthy(); expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.scope).toBe("memes:read");
    expect((await rpc(refreshed.access_token, "tools/call", { name: "list_memes", arguments: {} })).result.structuredContent.items.map((item: any) => item.id)).toEqual(["own"]);
    const connections = await call("/app/api/connections", { headers: { Cookie: session } });
    expect(connections.status).toBe(200);
    const { items } = await connections.json() as any;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ client: "Offline <client>", scope: ["memes:read"] });
    expect((await call(`/app/api/connections/${encodeURIComponent(items[0].id)}`, { method: "DELETE", headers: { Cookie: session } })).status).toBe(200);
    for (const access of [token.access_token, refreshed.access_token]) {
      expect((await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${access}` }, body: "{}" })).status).toBe(401);
    }
    expect((await refresh(refreshed.refresh_token)).status).toBe(400);
    expect(externalRequests).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(root, { recursive: true });
  }
}, 20_000);
