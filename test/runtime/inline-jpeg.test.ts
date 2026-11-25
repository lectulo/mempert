import { expect, spyOn, test } from "bun:test";
import type { Env } from "../../src/env";
import { InlineImageUnavailable, inlineJpeg } from "../../src/inlinejpeg";

function converter(name: string) {
  const gate = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const reads: number[] = [], calls: number[] = [];
  const bytes = new Uint8Array([255, 216, 255, 255, 217]);
  let active = 0, peak = 0;
  const env = {
    MEDIA: { get: async (key: string) => {
      reads.push(Number(key));
      return { version: "1", size: 1, arrayBuffer: async () => Uint8Array.of(Number(key)).buffer };
    } },
    THUMB: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async (_url: string, init: RequestInit) => {
        calls.push(new Uint8Array(init.body as ArrayBuffer)[0]);
        peak = Math.max(peak, ++active);
        if (calls.length === 2) ready.resolve();
        await gate.promise;
        active--;
        return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
      } }),
    },
  } as unknown as Env;
  return {
    reads, calls, bytes, gate, ready,
    get peak() { return peak; },
    get: (i: number) => inlineJpeg(env, `${name}/${i}`, { key: String(i), version: "1" } as R2Object, "image/png", i % 2 === 1),
  };
}

test("a cold burst queues 50 photo/thumbnail pairs and deduplicates running and queued misses", async () => {
  const c = converter("burst");
  // 2 admitted conversions + 128 queued, including the entire 100-variant burst.
  const ids = Array.from({ length: 130 }, (_, i) => i);
  const jobs = ids.map(c.get);
  const runningDuplicate = c.get(0), queuedDuplicate = c.get(99);
  const results = Promise.allSettled([...jobs, runningDuplicate, queuedDuplicate]);
  try {
    await expect(c.get(130)).rejects.toBeInstanceOf(InlineImageUnavailable);
    await c.ready.promise;
    expect(c.reads).toEqual([0, 1]);
    expect(c.calls).toEqual([0, 1]);
    c.gate.resolve();
    const bytes = await Promise.all(jobs);
    expect(bytes).toEqual(ids.map(() => c.bytes));
    expect(await runningDuplicate).toBe(bytes[0]);
    expect(await queuedDuplicate).toBe(bytes[99]);
    expect(c.reads).toEqual(ids);
    expect(c.calls).toEqual(ids);
    expect(c.peak).toBe(2);
    expect(await c.get(99)).toBe(bytes[99]);
    expect(c.calls).toEqual(ids);
  } finally {
    c.gate.resolve();
    await results;
  }
});

test("queued misses past their deadline never read the source, and can be retried", async () => {
  const c = converter("expired");
  const now = spyOn(performance, "now").mockReturnValue(0);
  const first = c.get(0), second = c.get(1), waiting = c.get(2), duplicate = c.get(2);
  const expired = Promise.allSettled([waiting, duplicate]);
  try {
    // Simulate a delayed timer callback: drain still checks the absolute deadline.
    now.mockReturnValue(60_000);
    c.gate.resolve();
    await Promise.all([first, second]);
    expect(await expired).toEqual([
      { status: "rejected", reason: expect.any(InlineImageUnavailable) },
      { status: "rejected", reason: expect.any(InlineImageUnavailable) },
    ]);
    expect(c.reads).toEqual([0, 1]);
    expect(await c.get(2)).toEqual(c.bytes);
    expect(c.reads).toEqual([0, 1, 2]);
  } finally {
    c.gate.resolve();
    now.mockRestore();
    await Promise.allSettled([first, second, expired]);
  }
});
