// Run from the repository root: bun test ./test/go-e2e/roundtrip.test.ts
// Requires .tmp/go-e2e/{zipimport,analyze}; builds are deliberately separate.
import { expect, mock, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDatabase } from "../../src/runtime/db";
import { createStorage } from "../../src/runtime/storage";
import { createVectors } from "../../src/runtime/vectors";
import type { Env } from "../../src/env";
const { sign } = await import("../../src/media");

test("real Go export -> restore -> dedupe -> analysis with local callback handlers", async () => {
  const repo = resolve(import.meta.dir, "../..");
  const scratch = join(repo, ".tmp/go-e2e");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "roundtrip-"));
  const db = createDatabase(join(root, "db.sqlite"), join(repo, "migrations"));
  const media = createStorage(join(root, "media"));
  const jobs: unknown[] = [];
  const queue = {
    send: async (body: unknown) => { jobs.push(body); },
    sendBatch: async (messages: { body: unknown }[]) => { jobs.push(...messages.map(m => m.body)); },
  };
  const env = {
    DB: db, MEDIA: media, VECTORS: createVectors(db, 1536), JOBS: queue, UPLOADS: queue,
    LIVE: { send() {} }, PUBLIC_URL: "https://fixture.invalid", INTERNAL_URL: "http://127.0.0.1",
    ENCRYPTION_KEY: "go-e2e-local-only", BOT_TOKEN: "1:fixture", SELF_HOSTED: "true",
  } as unknown as Env;
  const originalFetch = globalThis.fetch;
  const unexpected: string[] = [];
  const callbacks: { path: string; status: number }[] = [];
  let telegram = 0;
  // Real business handlers may notify Telegram. Return a local Bot API response;
  // no request (including requests with accidentally supplied credentials) leaves this process.
  const guard = mock(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.telegram.org" && url.pathname === "/bot1:fixture/sendMessage") {
      telegram++;
      return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 910002, type: "private" } } });
    }
    unexpected.push(url.origin + url.pathname);
    throw new Error("E2E forbids outbound fetch");
  });
  globalThis.fetch = guard as unknown as typeof fetch;
  // grammY's Node shim imports node-fetch rather than globalThis.fetch.
  mock.module("node-fetch", () => ({ default: guard }));
  // Import handlers only after installing both guards. Run this file in a
  // separate Bun test process so module mocks cannot affect other suites.
  const { handleExport } = await import("../../src/export");
  const { handleZipCallback } = await import("../../src/zip");
  const { handleAnalysis } = await import("../../src/analysis");
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      try {
        const response = path.startsWith("/export/") ? await handleExport(req, env)
          : path.startsWith("/zip/") ? await handleZipCallback(req, env)
          : path.startsWith("/analysis/") ? await handleAnalysis(req, env)
          : new Response("Not found", { status: 404 });
        callbacks.push({ path, status: response.status });
        return response;
      } catch (error) {
        callbacks.push({ path, status: 500 });
        console.error("Callback failed", path, error);
        return new Response("Callback failed", { status: 500 });
      }
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  async function run(binary: "zipimport" | "analyze", family: string, id: string, mode: string) {
    const token = await sign(env, `${family}|${id}`);
    // An explicit environment prevents inherited production credentials and proxy settings.
    const child = Bun.spawn([join(scratch, binary)], {
      cwd: root, env: { GOMAXPROCS: "2", TMPDIR: root, MODE: mode, TOKEN: token,
        API_URL: `${base}/${family}/${id}`, ZIP_URL: `${base}/${family}/${id}/file` },
      stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 90_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`${binary}/${mode} exited ${code}\n${stdout}\n${stderr}`);
    } finally { clearTimeout(timeout); }
  }
  async function denied(family: string, id: string, action: string, validToken = false) {
    const token = validToken ? await sign(env, `${family}|${id}`) : "wrong";
    const response = await originalFetch(`${base}/${family}/${id}/${action}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
  }
  try {
    for (const id of [910001, 910002]) await db.prepare("INSERT INTO users (id, role, lang) VALUES (?, 'user', 'en')").bind(id).run();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
    const sha = createHash("sha256").update(png).digest("hex");
    await media.put("fixtures/photo.png", png, { httpMetadata: { contentType: "image/png" } });
    await db.prepare(`INSERT INTO memes (id,user_id,kind,file_id,file_unique_id,status,title,description,tags,mime,r2_file,sha256,created_at,saved_at)
      VALUES ('fixture_photo',910001,'photo','','fixture:photo','ready','Offline fixture','Tiny local roundtrip','fixture\nlocal','image/png','fixtures/photo.png',?,1700000000,1700000100)`)
      .bind(sha).run();
    const image = Array(1536).fill(0); image[0] = 1;
    const text = Array(1536).fill(0); text[0] = 0.8; text[1] = 0.6;
    await env.VECTORS.upsert([{ id: "fixture_photo:i", namespace: "u910001", values: image }, { id: "fixture_photo:t", namespace: "u910001", values: text }]);
    await db.prepare("INSERT INTO exports (id,user_id,status) VALUES ('e2e_export',910001,'running')").run();
    await denied("export", "e2e_export", "table/memes");
    await run("zipimport", "export", "e2e_export", "export");
    const ex = await db.prepare("SELECT status,files,failed FROM exports WHERE id='e2e_export'").first();
    expect(ex).toEqual({ status: "done", files: 1, failed: 0 });
    const archive = await media.get("tmp/export/e2e_export.zip");
    expect(archive).not.toBeNull();
    const archiveBytes = await archive!.arrayBuffer();
    expect(Buffer.from(archiveBytes).subarray(0, 2).toString()).toBe("PK");
    await denied("export", "e2e_export", "table/memes", true);
    for (const id of ["e2e_zip", "e2e_repeat"]) {
      await db.prepare("INSERT INTO zip_imports (id,user_id,import_id,status) VALUES (?,910002,?,'running')").bind(id, `${id}_import`).run();
      await media.put(`tmp/zip/${id}.zip`, archiveBytes);
      await denied("zip", id, "file");
      await run("zipimport", "zip", id, "import");
      expect(await db.prepare("SELECT status,imported,skipped,format FROM zip_imports WHERE id=?").bind(id).first<{status:string;imported:number;skipped:number;format:string}>())
        .toEqual({ status: "done", imported: id === "e2e_zip" ? 1 : 0, skipped: id === "e2e_zip" ? 0 : 1, format: "memesave" });
      await denied("zip", id, "file", true);
    }
    const restored = await db.prepare("SELECT * FROM memes WHERE user_id=910002").all<Record<string, any>>();
    expect(restored.results).toHaveLength(1);
    const meme = restored.results[0];
    for (const [key, value] of Object.entries({ status: "ready", title: "Offline fixture", description: "Tiny local roundtrip", tags: "fixture\nlocal", sha256: sha, created_at: 1700000000, saved_at: 1700000100 })) expect(meme[key]).toEqual(value);
    expect(Buffer.from(await (await media.get(meme.r2_file))!.arrayBuffer())).toEqual(png);
    const vectors = await env.VECTORS.getByIds([`${meme.id}:i`, `${meme.id}:t`]);
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) { expect(vector.namespace).toBe("u910002"); expect(vector.values.length).toBe(1536); }
    expect(vectors.find(v => v.id.endsWith(":t"))!.values[0]).toBeCloseTo(0.8, 6);
    expect(jobs).toEqual([]);
    await db.prepare("INSERT INTO analyses (id,user_id,status,llm,chat) VALUES ('e2e_analysis',910002,'running',0,0)").run();
    await media.put("tmp/analysis/e2e_analysis/moods.json", "[]");
    await denied("analysis", "e2e_analysis", "memes");
    await run("analyze", "analysis", "e2e_analysis", "analyze");
    expect(await db.prepare("SELECT status FROM analyses WHERE id='e2e_analysis'").first<string>("status")).toBe("done");
    const result = await (await media.get("tmp/analysis/e2e_analysis.json"))!.json<any>();
    expect(result.count).toBe(1);
    expect(result.image.ids).toContain(meme.id); expect(result.text.ids).toContain(meme.id);
    expect(result.images.length).toBeGreaterThan(0);
    for (const name of result.images) {
      const bytes = Buffer.from(await (await media.get(`tmp/analysis/e2e_analysis/${name}.png`))!.arrayBuffer());
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    }
    await denied("analysis", "e2e_analysis", "memes", true);
    expect(callbacks.filter(c => c.status >= 500)).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(telegram).toBe(3);
    expect(jobs).toEqual([]);
    console.log(`Go E2E: ${callbacks.length} callbacks, ${result.images.length} PNGs, ${telegram} locally stubbed Telegram notifications; no external requests.`);
  } finally {
    server.stop(true); globalThis.fetch = originalFetch;
    media.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
