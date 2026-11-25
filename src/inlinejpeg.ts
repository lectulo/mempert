import type { Env } from "./env";

export const INLINE_IMAGE_INPUT_MAX = 24 * 1024 * 1024;
export const INLINE_PHOTO_MAX = 5_000_000;
export const INLINE_THUMB_MAX = 200_000;

const CACHE_MAX = 24 * 1024 * 1024;
const CACHE_TTL = 10 * 60_000;
const CONVERSION_SLOTS = 2; // Match the private thumb service's inline-image limit.
const QUEUE_MAX = 128; // 50 inline results can each need both a photo and a thumbnail.
const QUEUE_WAIT_MS = 15_000;
type Jpeg = Uint8Array<ArrayBuffer>;
const cache = new Map<string, { jpeg: Jpeg; expires: number }>();
let cacheBytes = 0;
const pending = new Map<string, Promise<Jpeg | null>>();
const queued = new Map<string, () => void>();
let running = 0;

export class InlineImageUnavailable extends Error {}

function evict(key: string) {
  const entry = cache.get(key)!;
  cache.delete(key);
  cacheBytes -= entry.jpeg.byteLength;
}

function drain() {
  while (running < CONVERSION_SLOTS && queued.size) {
    const [id, start] = queued.entries().next().value!;
    queued.delete(id);
    start();
  }
}

/** Share one pending conversion per revision and size. Only running work reads source bytes. */
export async function inlineJpeg(env: Env, id: string, source: R2Object, mime: string, small: boolean): Promise<Jpeg | null> {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expires <= now) evict(key);
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit.jpeg;
  }
  const existing = pending.get(id);
  if (existing) return existing;
  if (queued.size >= QUEUE_MAX) throw new InlineImageUnavailable();

  const task = Promise.withResolvers<Jpeg | null>();
  pending.set(id, task.promise);
  const deadline = performance.now() + QUEUE_WAIT_MS;
  const expire = () => {
    queued.delete(id);
    pending.delete(id);
    task.reject(new InlineImageUnavailable());
  };
  const timer = setTimeout(expire, QUEUE_WAIT_MS);
  queued.set(id, () => {
    clearTimeout(timer);
    // Check elapsed time too, in case the timer callback was delayed.
    if (performance.now() >= deadline) { expire(); return; }
    running++;
    void (async () => {
      try { task.resolve(await convert(env, id, source, mime, small)); }
      catch (error) { task.reject(error); }
      finally {
        running--;
        pending.delete(id);
        drain();
      }
    })();
  });
  drain();
  return task.promise;
}

async function convert(env: Env, id: string, source: R2Object, mime: string, small: boolean): Promise<Jpeg | null> {
  const object = await env.MEDIA.get(source.key);
  if (!object) return null;
  if (object.version !== source.version || object.size <= 0 || object.size > INLINE_IMAGE_INPUT_MAX) {
    await object.body.cancel();
    return null;
  }
  const body = await object.arrayBuffer();
  let res: Response;
  try {
    res = await env.THUMB.get(env.THUMB.idFromName("inline-image")).fetch(`http://thumb/inline-image/${small ? "thumbnail" : "photo"}`, {
      method: "POST", body, headers: { "Content-Type": mime },
      redirect: "error", signal: AbortSignal.timeout(6_000),
    });
  } catch { throw new InlineImageUnavailable(); }
  const limit = small ? INLINE_THUMB_MAX : INLINE_PHOTO_MAX;
  if (!res.ok || res.headers.get("Content-Type") !== "image/jpeg" || !res.body || Number(res.headers.get("Content-Length")) > limit) {
    await res.body?.cancel().catch(() => {});
    if (res.status >= 500 && res.status < 600) throw new InlineImageUnavailable();
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { throw new InlineImageUnavailable(); }
  finally { reader.releaseLock(); }
  if (size < 4) return null;
  const jpeg = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { jpeg.set(chunk, offset); offset += chunk.byteLength; }
  if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[2] !== 255 || jpeg[size - 2] !== 255 || jpeg[size - 1] !== 217) return null;
  while (cache.size >= 128 || cacheBytes + size > CACHE_MAX) evict(cache.keys().next().value!);
  cache.set(id, { jpeg, expires: Date.now() + CACHE_TTL });
  cacheBytes += size;
  return jpeg;
}
