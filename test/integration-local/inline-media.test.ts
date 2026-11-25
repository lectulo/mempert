import { expect, mock, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { getMeme } from "../../src/db";
import { serveMedia, signedMediaUrl } from "../../src/media";
import { fixture } from "./fixture";
const { toInlineResult } = await import("../../src/search/deliver");

const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAQDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==", "base64");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADAQMAAACOOjyFAAAAA1BMVEX/AAAZ4gk3AAAAC0lEQVQI12NgAAEAAAYAAWb0yWwAAAAASUVORK5CYII=", "base64");
const ctx = {} as ExecutionContext;

test("PNG originals keep their batch URL; Telegram gets private, revision-bound JPEGs", async () => {
  const f = await fixture();
  try {
    const { env } = f;
    env.PUBLIC_URL = "http://localhost:3000";
    env.MEDIA_URL = "https://media.example.com";
    const m = await f.meme("still", 101);
    const key = "u/101/still.png";
    await env.MEDIA.put(key, png, { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare("UPDATE memes SET mime = 'image/png', r2_file = ? WHERE id = ?").bind(key, m.id).run();
    const fresh = (await getMeme(env.DB, m.id))!;
    const calls: string[] = [];
    env.THUMB = {
      idFromName: (name) => name,
      get: () => ({ fetch: async (input, init) => {
        calls.push(String(input));
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "image/png" });
        expect(Buffer.from(init!.body as ArrayBuffer)).toEqual(png);
        return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      } }),
    };

    const result = await toInlineResult(env, fresh);
    if (result?.type !== "photo" || !("photo_url" in result)) throw new Error("expected a URL photo result");
    const { photo_url: photo, thumbnail_url: thumb } = result;
    expect(new URL(photo).origin).toBe(env.MEDIA_URL!);
    expect(new URL(thumb).origin).toBe(env.MEDIA_URL!);
    expect(new URL(photo).pathname).toBe("/media/still.tg-photo.jpg");
    expect(new URL(thumb).pathname).toBe("/media/still.tg-thumb.jpg");
    const original = await signedMediaUrl(env, fresh, "file", 60, env.MEDIA_URL);
    const get = (url: string, init?: RequestInit) => serveMedia(new Request(url, init), env, ctx);
    const lookalike = new URL(photo);
    lookalike.searchParams.set("s", new URL(thumb).searchParams.get("s")!);
    for (const bad of [photo.split("?")[0], photo.replace(".jpg", ".gif"), photo.replace("still", "another"),
      photo.replace("tg-photo", "tg-thumb"), lookalike.href, original.replace("file.png", "tg-photo.jpg")]) {
      expect((await get(bad, { method: "HEAD" })).status).toBe(404);
    }
    expect(calls).toEqual([]);

    const [head, first] = await Promise.all([get(photo, { method: "HEAD" }), get(photo)]);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe(String(jpeg.length));
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(jpeg);
    const preview = await get(thumb, { headers: { range: "bytes=1-2" } });
    expect(preview.status).toBe(206);
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(jpeg.subarray(1, 3));
    expect(calls).toEqual(["http://thumb/inline-image/photo", "http://thumb/inline-image/thumbnail"]);

    const batch = await get(original);
    expect(new URL(original).pathname).toBe("/media/still.file.png");
    expect(batch.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await batch.arrayBuffer())).toEqual(png);
    expect(await getMeme(env.DB, m.id)).toEqual(fresh);
    expect(f.jobs).toEqual([]);

    await env.MEDIA.put(key, png, { httpMetadata: { contentType: "image/png" } });
    expect((await get(photo)).status).toBe(404);
    const updated = await toInlineResult(env, fresh);
    expect(updated).not.toEqual(result);
    await env.DB.prepare("DELETE FROM memes WHERE id = ?").bind(m.id).run();
    expect((await get(thumb)).status).toBe(404);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(calls).toHaveLength(2);
  } finally { f.close(); }
});

test("file_id wins, localhost yields no URL, and JPEG upload dimensions never bypass conversion", async () => {
  const f = await fixture();
  try {
    const { env } = f;
    const m = await f.meme("jpeg", 101);
    // A real 4×3 JPEG with an EXIF tag requesting a 90° clockwise rotation.
    const rotated = Buffer.concat([jpeg.subarray(0, 2), Buffer.from("ffe1002245786966000049492a0008000000010012010300010000000600000000000000", "hex"), jpeg.subarray(2)]);
    await env.MEDIA.put(m.r2_file!, rotated, { httpMetadata: { contentType: "image/jpeg" } });
    env.PUBLIC_URL = "https://localhost:3000";
    expect(await toInlineResult(env, { ...m, file_id: "tg-photo-id", r2_file: null })).toEqual({ type: "photo", id: m.id, photo_file_id: "tg-photo-id" });
    expect(await toInlineResult(env, m)).toBeNull();
    env.PUBLIC_URL = "https://app.example.com";
    await env.DB.prepare("UPDATE memes SET width = 1, height = 1 WHERE id = ?").bind(m.id).run();
    const fresh = (await getMeme(env.DB, m.id))!;
    const calls: string[] = [];
    env.THUMB = {
      idFromName: (name) => name,
      get: () => ({ fetch: async (input, init) => {
        calls.push(String(input));
        expect(init?.headers).toEqual({ "Content-Type": "image/jpeg" });
        expect(Buffer.from(init!.body as ArrayBuffer)).toEqual(rotated);
        return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      } }),
    };
    const result = await toInlineResult(env, fresh);
    if (result?.type !== "photo" || !("photo_url" in result)) throw new Error("expected a URL photo result");
    expect(new URL(result.photo_url).origin).toBe(env.PUBLIC_URL);
    for (const url of [result.photo_url, result.thumbnail_url]) {
      const derivative = await serveMedia(new Request(url), env, ctx);
      expect(derivative.status).toBe(200);
      expect(Buffer.from(await derivative.arrayBuffer())).toEqual(jpeg);
    }
    expect(calls).toEqual(["http://thumb/inline-image/photo", "http://thumb/inline-image/thumbnail"]);
    const original = await serveMedia(new Request(await signedMediaUrl(env, fresh, "file", 60)), env, ctx);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(rotated);
  } finally { f.close(); }
});

test("URL video and animation results use their stored content types", async () => {
  const f = await fixture();
  try {
    const { env } = f;
    const m = await f.meme("motion", 101);
    const make = async (kind: "animation" | "video", mime: string, thumbnail: boolean) => {
      await env.DB.prepare("UPDATE memes SET kind = ?, r2_preview = ? WHERE id = ?").bind(kind, thumbnail ? m.r2_preview : null, m.id).run();
      await env.MEDIA.put(m.r2_file!, "MOTION", { httpMetadata: { contentType: mime } });
      return toInlineResult(env, (await getMeme(env.DB, m.id))!);
    };
    expect(await make("video", "video/webm", true)).toBeNull();
    expect(await make("video", "video/mp4", false)).toBeNull();
    expect(await make("video", "video/mp4", true)).toMatchObject({ type: "video", mime_type: "video/mp4", thumbnail_url: expect.stringContaining(".tg-thumb.jpg") });
    for (const [mime, field, type] of [["image/gif", "gif_url", "gif"], ["video/mp4", "mpeg4_url", "mpeg4_gif"]]) {
      const result = await make("animation", mime, false);
      expect(result).toMatchObject({ type, thumbnail_mime_type: mime });
      if (!result || !(field in result) || !("thumbnail_url" in result) || !result.thumbnail_url) throw new Error("expected a URL animation result");
      const url = result.thumbnail_url;
      expect(result).toMatchObject({ [field]: url });
      const head = await serveMedia(new Request(url, { method: "HEAD" }), env, ctx);
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe(mime);
    }
  } finally { f.close(); }
});

test("conversion misses are bounded and deletion during conversion revokes the result", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  try {
    const { env } = f;
    const ready = Promise.withResolvers<void>();
    let running = 0;
    env.THUMB = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => {
        if (++running === 2) ready.resolve();
        await gate.promise;
        return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      } }),
    };
    const urls = [];
    for (const id of ["p1", "p2", "p3"]) {
      const m = await f.meme(id, 101);
      await env.MEDIA.put(m.r2_file!, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
      const result = await toInlineResult(env, m);
      if (result?.type !== "photo" || !("photo_url" in result)) throw new Error("expected a URL photo result");
      urls.push(result.photo_url);
    }
    const get = (url: string) => serveMedia(new Request(url), env, ctx);
    const first = get(urls[0]), second = get(urls[1]);
    await ready.promise;
    const third = get(urls[2]);
    await env.DB.prepare("UPDATE memes SET r2_file = NULL WHERE id = 'p1'").run();
    gate.resolve();
    expect((await first).status).toBe(404);
    expect((await second).status).toBe(200);
    expect((await third).status).toBe(200);
    expect(running).toBe(3);
  } finally { gate.resolve(); f.close(); }
});

test("signed derivatives distinguish converter outages from permanent misses", async () => {
  const f = await fixture();
  try {
    const { env } = f;
    const m = await f.meme("converter-outage", 101);
    const result = await toInlineResult(env, m);
    if (result?.type !== "photo" || !("photo_url" in result)) throw new Error("expected a URL photo result");
    const url = result.photo_url;
    const serve = (method: string, target = url) => serveMedia(new Request(target, { method }), env, ctx);
    const jpegHeaders = { "Content-Type": "image/jpeg" };

    let convert = async (): Promise<Response> => { throw new TypeError("private converter address"); };
    let calls = 0;
    env.THUMB = {
      idFromName: (name) => name,
      get: () => ({ fetch: () => { calls++; return convert(); } }),
    };

    const bad = new URL(url);
    bad.searchParams.set("s", "A".repeat(43));
    expect((await serve("GET", bad.href)).status).toBe(404);
    expect(calls).toBe(0);

    const expectRetry = async (method: string) => {
      const response = await serve(method);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (method === "HEAD") expect(response.body).toBeNull();
      else expect(await response.text()).toBe("Try again");
    };
    await expectRetry("GET");
    convert = async () => { throw new DOMException("private converter timeout", "TimeoutError"); };
    await expectRetry("HEAD");
    convert = async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new DOMException("private read timeout", "TimeoutError")); },
    }), { headers: jpegHeaders });
    await expectRetry("GET");
    for (const status of [500, 503, 504]) {
      convert = async () => new Response("private converter error", { status });
      await expectRetry("GET");
    }
    for (const status of [404, 422]) {
      convert = async () => new Response(null, { status });
      const missing = await serve("GET");
      expect(missing.status).toBe(404);
      expect(missing.headers.get("retry-after")).toBeNull();
    }
    convert = async () => new Response(jpeg, { headers: jpegHeaders });
    expect((await serve("GET")).status).toBe(200);
  } finally { f.close(); }
});
