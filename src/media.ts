import { Buffer } from "node:buffer";
import type { Meme } from "./db";
import type { Env } from "./env";
import { INLINE_IMAGE_INPUT_MAX, InlineImageUnavailable, inlineJpeg } from "./inlinejpeg";
import { telegramFetch } from "./telegramproxy";

export interface Media {
  bytes: ArrayBuffer;
  mime: string;
}

const EXT_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg", // after "jpeg": the reverse map picks the last extension
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/mov",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/opus",
  aac: "audio/aac",
  wav: "audio/wav",
};

const MIME_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXT_MIME).map(([ext, mime]) => [mime, ext])),
  "video/quicktime": "mov",
  "image/heic": "heic",
  "audio/x-m4a": "m4a",
  "audio/webm": "webm",
};
export const extOf = (mime: string) => MIME_EXT[mime] ?? "bin";

/**
 * R2 keys end with the file extension: presigned R2 links then end with it too, and Vertex batch only
 * fetches image URLs with a recognized extension.
 */
export const fileKey = (base: string, mime: string) => `${base}.${extOf(mime)}`;
export const previewKey = (base: string) => `${base}.preview.jpg`;
export const hasExt = (key: string) => /\.(jpe?g|png|webp|heic|gif|mp4|mov|webm|bin)$/i.test(key);
export const KEY_EXTS = ["jpg", "jpeg", "png", "webp", "heic", "gif", "mp4", "mov", "webm", "bin"];

/** The meme fields media access needs. */
export type MediaMeme = Pick<Meme, "id" | "kind" | "mime" | "file_id" | "preview_file_id" | "r2_file" | "r2_preview">;
export type Variant = "file" | "preview";

/** Temporary objects (query embeddings, inline cache, zip uploads): the bucket expires "tmp/" after 7 days. */
export const tmpKey = (name: string) => `tmp/${name}`;

/** "preview" when the meme has its own preview (Telegram thumbnail / 640 px size, uploaded thumbnail), else "file". */
export const variantOf = (m: MediaMeme, v: Variant): Variant => (v === "preview" && (m.r2_preview || m.preview_file_id) ? "preview" : "file");

const fallbackMime = (m: MediaMeme, v: Variant) => (v === "preview" ? "image/jpeg" : (m.mime ?? (m.kind === "photo" ? "image/jpeg" : "video/mp4")));

async function downloadTelegram(env: Env, fileId: string, fallback: string): Promise<Media> {
  const info = await telegramFetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`, undefined, env.OUTBOUND_PROXY_URL);
  const { ok, result } = await info.json<{ ok: boolean; result?: { file_path?: string } }>();
  if (!ok || !result?.file_path) throw new Error(`getFile failed for ${fileId}`);
  const res = await telegramFetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${result.file_path}`, undefined, env.OUTBOUND_PROXY_URL);
  if (!res.ok) throw new Error(`Telegram download ${res.status} for ${fileId}`);
  return { bytes: await res.arrayBuffer(), mime: EXT_MIME[result.file_path.split(".").pop()!.toLowerCase()] ?? fallback };
}

/**
 * Bytes of a meme's file or preview. Every meme keeps a permanent copy in R2 (MEDIA); a meme that is only
 * in Telegram is downloaded once and saved there (back-fill). Bot API downloads are limited to 20 MB.
 */
export async function memeMedia(env: Env, m: MediaMeme, variant: Variant): Promise<Media> {
  const v = variantOf(m, variant);
  const key = v === "preview" ? m.r2_preview : m.r2_file;
  const fallback = fallbackMime(m, v);
  if (key) {
    const obj = await env.MEDIA.get(key);
    if (obj) return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType ?? fallback };
  }
  const fileId = v === "preview" ? m.preview_file_id : m.file_id;
  if (!fileId) throw new Error(`No ${v} for meme ${m.id}`);
  const media = await downloadTelegram(env, fileId, fallback);
  const newKey = v === "preview" ? previewKey(`memes/${m.id}/file`) : fileKey(`memes/${m.id}/file`, media.mime);
  await env.MEDIA.put(newKey, media.bytes, { httpMetadata: { contentType: media.mime } });
  await env.DB.prepare(`UPDATE memes SET ${v === "preview" ? "r2_preview" : "r2_file"} = ? WHERE id = ?`).bind(newKey, m.id).run();
  if (v === "preview") m.r2_preview = newKey;
  else m.r2_file = newKey;
  return media;
}

export const toDataUrl = ({ bytes, mime }: Media) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

// The key is imported once per isolate: a big album signs thousands of URLs.
let key: [string, Promise<CryptoKey>] | undefined;
const hmacKey = (secret: string) =>
  (key?.[0] === secret ? key : (key = [secret, crypto.subtle.importKey("raw", new TextEncoder().encode(`media|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])]))[1];

/** HMAC-SHA256 of `msg` with a key derived from ENCRYPTION_KEY, base64url. */
export const sign = async (env: Env, msg: string) =>
  Buffer.from(await crypto.subtle.sign("HMAC", await hmacKey(env.ENCRYPTION_KEY), new TextEncoder().encode(msg))).toString("base64url");

export const verify = async (env: Env, msg: string, sig: string) =>
  crypto.subtle.verify("HMAC", await hmacKey(env.ENCRYPTION_KEY), Buffer.from(sig, "base64url"), new TextEncoder().encode(msg));

const DAY = 86400;

/**
 * `?e=<exp>&s=<sig>` for `scope`, valid at least `ttlSeconds`. The expiry is rounded up to a whole day,
 * so the URL stays the same all day: browsers and Telegram cache media by URL.
 */
export async function signedQuery(env: Env, scope: string, ttlSeconds: number) {
  const exp = Math.ceil((Math.floor(Date.now() / 1000) + ttlSeconds) / DAY) * DAY;
  return `?e=${exp}&s=${await sign(env, `${scope}|${exp}`)}`;
}

const mediaNotFound = (req: Request) => new Response(req.method === "HEAD" ? null : "Not found", { status: 404 });

/**
 * Media behind a signed URL never changes, so it is cached until the URL expires: by the browser,
 * by Telegram and by browser caches. The server does not keep another in-memory media copy.
 */
export async function cachedMedia(
  req: Request,
  ctx: ExecutionContext,
  load: () => Promise<Response | null>,
  maxAge = Math.max(0, Number(new URL(req.url).searchParams.get("e")) - Math.floor(Date.now() / 1000)),
): Promise<Response> {
  const res = await load();
  if (!res) return mediaNotFound(req);
  res.headers.set("Cache-Control", `public, max-age=${maxAge}, immutable`);
  res.headers.set("Accept-Ranges", "bytes");
  const range = req.headers.get("Range");
  if (range && res.status === 200) {
    const bytes = await res.arrayBuffer(), size = bytes.byteLength;
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0, end = size - 1;
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
    }
    const headers = new Headers(res.headers);
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
  }
  return res;
}

export async function verifyQuery(env: Env, scope: string, url: URL) {
  const exp = Number(url.searchParams.get("e"));
  return exp > Date.now() / 1000 && verify(env, `${scope}|${exp}`, url.searchParams.get("s") ?? "");
}

/**
 * Public URL of an original file or preview (e.g. OpenRouter Batch).
 * The path ends with a file extension: Vertex batch rejects image URLs without one.
 */
export async function signedMediaUrl(env: Env, m: MediaMeme, variant: Variant, ttlSeconds: number, base = env.PUBLIC_URL) {
  const v = variantOf(m, variant);
  const ext = v === "preview" ? "jpg" : extOf(fallbackMime(m, v));
  return `${base.replace(/\/$/, "")}/media/${m.id}.${v}.${ext}${await signedQuery(env, `media|${m.id}|${v}`, ttlSeconds)}`;
}

/** Streams local objects, including a bounded single byte range. Telegram-only files are backfilled once. */
export async function mediaResponse(env: Env, m: MediaMeme, variant: Variant, req?: Request): Promise<Response | null> {
  const v = variantOf(m, variant);
  let key = v === "preview" ? m.r2_preview : m.r2_file;
  let info = key ? await env.MEDIA.head(key) : null;
  if (!info) {
    await memeMedia(env, m, v);
    const row = await env.DB.prepare("SELECT r2_file,r2_preview FROM memes WHERE id=?").bind(m.id).first<{r2_file:string|null;r2_preview:string|null}>();
    key = (v === "preview" ? row?.r2_preview : row?.r2_file) ?? null;
    info = key ? await env.MEDIA.head(key) : null;
  }
  if (!key || !info) return null;
  return byteResponse(req, info.size, info.httpMetadata?.contentType ?? fallbackMime(m, v), async (range) => {
    const object = await env.MEDIA.get(key, range ? {range} : undefined);
    return object?.body ?? null;
  });
}

async function byteResponse(req: Request | undefined, size: number, mime: string, body: (range?: {offset:number;length:number}) => Promise<ReadableStream | Uint8Array<ArrayBuffer> | null>) {
  const headers = new Headers({ "Content-Type": mime, "Accept-Ranges": "bytes", "Content-Length": String(size) });
  let range: {offset:number;length:number} | undefined;
  const requested = req?.headers.get("Range");
  if (requested) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(requested);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      headers.set("Content-Range", `bytes */${size}`); headers.delete("Content-Length");
      return new Response(null, {status:416,headers});
    }
    range = {offset:start,length:end-start+1};
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`); headers.set("Content-Length", String(range.length));
  }
  if (req?.method === "HEAD") return new Response(null, {status:range ? 206 : 200,headers});
  const data = await body(range);
  return data ? new Response(data, {status:range ? 206 : 200,headers}) : null;
}

const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const INLINE_MOTION_MAX = 20_000_000;
type InlineVariant = "tg-photo" | "tg-thumb" | "tg-motion";
type InlineSource = { object: R2Object; mime: string; revision: string };

async function inlineSource(env: Env, m: Meme, variant: InlineVariant): Promise<InlineSource | null> {
  const preview = variant === "tg-thumb" && m.kind !== "photo";
  if ((variant === "tg-photo" && m.kind !== "photo") || (variant === "tg-motion" && m.kind === "photo")) return null;
  const key = preview ? m.r2_preview : m.r2_file;
  const object = key ? await env.MEDIA.head(key) : null;
  if (!object || object.size <= 0) return null;
  const mime = object.httpMetadata?.contentType ?? fallbackMime(m, preview ? "preview" : "file");
  if (variant === "tg-motion") {
    if (!(mime === "video/mp4" || (m.kind === "animation" && mime === "image/gif")) || object.size > INLINE_MOTION_MAX) return null;
  } else if (!INLINE_IMAGE_TYPES.has(mime) || object.size > INLINE_IMAGE_INPUT_MAX) return null;
  // Version the JPEG derivatives separately from originals and check their actual geometry in the converter.
  const identity = JSON.stringify([m.user_id, m.id, m.kind, variant, key, object.version, mime, variant === "tg-motion" ? true : "jpeg-v1"]);
  const revision = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))).toString("base64url");
  return { object, mime, revision };
}

async function inlineUrl(env: Env, base: string, m: Meme, variant: InlineVariant, source: InlineSource, ttl: number) {
  const ext = variant === "tg-motion" ? extOf(source.mime) : "jpg";
  const path = `${m.id}.${variant}.${ext}`;
  return `${base.replace(/\/$/, "")}/media/${path}${await signedQuery(env, `inline-media|${path}|${source.revision}`, ttl)}&r=${source.revision}`;
}

/** Telegram URLs are revision-bound and never backfill from Telegram or rewrite originals. */
export async function inlineMediaUrls(env: Env, base: string, m: Meme, ttl: number) {
  const variant = m.kind === "photo" ? "tg-photo" : "tg-motion";
  const [source, thumb] = await Promise.all([inlineSource(env, m, variant), inlineSource(env, m, "tg-thumb")]);
  if (!source || (!thumb && m.kind !== "animation")) return null;
  const [url, thumbnail] = await Promise.all([
    inlineUrl(env, base, m, variant, source, ttl),
    thumb ? inlineUrl(env, base, m, "tg-thumb", thumb, ttl) : null,
  ]);
  return { url, thumbnail, mime: source.mime };
}

async function serveInlineMedia(req: Request, env: Env, url: URL, id: string, variant: InlineVariant, ext: string) {
  const missing = () => {
    const response = mediaNotFound(req);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  if (req.method !== "GET" && req.method !== "HEAD") return missing();
  const revision = url.searchParams.get("r") ?? "";
  const exp = url.searchParams.get("e") ?? "";
  const token = /^[\w-]{42}[AEIMQUYcgkosw048]$/; // canonical unpadded base64url for 32 bytes
  if (!token.test(revision) || !token.test(url.searchParams.get("s") ?? "") || !/^[1-9]\d{0,14}$/.test(exp) ||
      ["r", "s", "e"].some((name) => url.searchParams.getAll(name).length !== 1) ||
      !(await verifyQuery(env, `inline-media|${id}.${variant}.${ext}|${revision}`, url))) return missing();
  const current = async () => {
    const meme = await env.DB.prepare("SELECT * FROM memes WHERE id = ?").bind(id).first<Meme>();
    return meme ? inlineSource(env, meme, variant) : null;
  };
  try {
    const source = await current();
    if (!source || source.revision !== revision || ext !== (variant === "tg-motion" ? extOf(source.mime) : "jpg")) return missing();
    let response: Response | null;
    if (variant === "tg-motion") {
      response = await byteResponse(req, source.object.size, source.mime, async (range) => {
        const obj = await env.MEDIA.get(source.object.key, range ? { range } : undefined);
        if (!obj || obj.version === source.object.version) return obj?.body ?? null;
        await obj.body.cancel();
        return null;
      });
    } else {
      const jpeg = await inlineJpeg(env, revision, source.object, source.mime, variant === "tg-thumb");
      if (!jpeg) return missing();
      response = await byteResponse(req, jpeg.byteLength, "image/jpeg", async (range) =>
        range ? jpeg.subarray(range.offset, range.offset + range.length) : jpeg);
    }
    if (!response) return missing();
    // The row or source may have been detached while conversion or a storage read was in flight.
    if ((await current())?.revision !== revision) {
      await response.body?.cancel();
      return missing();
    }
    // Server-side cache only; a proxy must not bypass the live row/revision check after deletion.
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch (error) {
    if (error instanceof InlineImageUnavailable) return new Response(req.method === "HEAD" ? null : "Try again", { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    return missing();
  }
}

/** GET or HEAD /media/<memeId>.<file|preview>.<ext>?e=&s=. */
export async function serveMedia(req: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(req.url);
  const inline = /^\/media\/([\w-]{1,64})\.(tg-photo|tg-thumb|tg-motion)\.(jpg|gif|mp4)$/.exec(url.pathname);
  if (inline) return serveInlineMedia(req, env, url, inline[1], inline[2] as InlineVariant, inline[3]);
  const [id = "", variant = ""] = (url.pathname.split("/")[2] ?? "").split(".");
  if ((variant !== "file" && variant !== "preview") || !(await verifyQuery(env, `media|${id}|${variant}`, url))) {
    return mediaNotFound(req);
  }
  return cachedMedia(req, ctx, async () => {
    const m = await env.DB.prepare("SELECT * FROM memes WHERE id = ?").bind(id).first<Meme>();
    if (!m) return null;
    return mediaResponse(env, m, variant, req).catch(() => null);
  });
}
