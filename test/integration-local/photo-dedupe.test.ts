import { expect, mock, spyOn, test } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));
import { fixture, providerKey, vector } from "./fixture";
const { embedStage } = await import("../../src/ingest/embed");

test("concurrent ordinary photo embeds claim identical bytes only once", async () => {
  const f = await fixture();
  const oldProxy = process.env.OUTBOUND_PROXY_URL;
  process.env.OUTBOUND_PROXY_URL = "";
  await providerKey(f.env, "openrouter", "fake-embedding-key");
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    expect(String(input)).toBe("https://openrouter.ai/api/v1/embeddings");
    return Response.json({ data: [{ index: 0, embedding: vector() }] });
  }, { preconnect: fetch.preconnect }));
  // Release both hashes together so a split SELECT/UPDATE reads both snapshots before either write.
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const hashes = Promise.withResolvers<void>();
  let hashed = 0;
  const hash = spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    const value = await digest(algorithm, data);
    if (++hashed === 2) hashes.resolve();
    await hashes.promise;
    return value;
  });
  try {
    await f.meme("first", 91475);
    await f.meme("second", 91475);
    await f.env.DB.prepare("UPDATE memes SET status = 'embedding', title = NULL").run();

    await Promise.all([embedStage(f.env, "first"), embedStage(f.env, "second")]);

    const { results } = await f.env.DB.prepare("SELECT id, status, sha256 FROM memes").all<{ id: string; status: string; sha256: string }>();
    expect(results).toHaveLength(1);
    const winner = results[0]!;
    expect(winner.status).toBe("describing");
    expect(winner.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(network).toHaveBeenCalledTimes(1);
    expect(f.jobs).toEqual([{ type: "describe", memeId: winner.id, gen: 0 }]);
  } finally {
    hash.mockRestore();
    network.mockRestore();
    if (oldProxy === undefined) delete process.env.OUTBOUND_PROXY_URL;
    else process.env.OUTBOUND_PROXY_URL = oldProxy;
    f.close();
  }
});
