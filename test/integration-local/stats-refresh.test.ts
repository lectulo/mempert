import { expect, mock, test } from "bun:test";
import { watchVisibleRefresh } from "../../app/src/visible-refresh";
import { getUser } from "../../src/db";
import { fixture } from "./fixture";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { resultKey } = await import("../../src/analysis");
const { createShare, handleSharedAnalysis } = await import("../../src/analysisshare");
const { handleAccount } = await import("../../src/webaccount");

test("live stats refresh from 52 to 57 without changing private or shared analysis snapshots", async () => {
  const f = await fixture();
  let stop: (() => void) | undefined;
  try {
    await f.db.exec(`INSERT INTO users (id, role) VALUES (1, 'user');
      WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n < 52)
      INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status)
      SELECT 'm' || n, 1, 'photo', 'file', 'm' || n, IIF(n <= 50, 'ready', 'failed') FROM rows;
      INSERT INTO analyses (id, user_id, status, created_at) VALUES ('snapshot', 1, 'done', 1790000000);`);
    const user = (await getUser(f.db, 1))!;
    const get = async (path: string, signal?: AbortSignal) =>
      (await handleAccount(new Request(`https://local.invalid/app/api/${path}`, { signal }), f.env, user, path.split("/")))!;

    const stats = await (await get("stats")).json<{ total: number }>();
    const snapshot = { created_at: 1790000000, count: 50, analytics: { stats } };
    await f.env.MEDIA.put(resultKey("snapshot"), JSON.stringify(snapshot));
    const link = await createShare(f.env, 1, 1);
    if (!link || link === "parts") throw new Error("Expected a public snapshot link");
    const readShared = async () => (await handleSharedAnalysis(f.env, link.id)).json();
    const publicSnapshot = await readShared();
    expect(publicSnapshot).toMatchObject({ result: snapshot });

    let invalidate = () => {};
    let visible = true;
    let reads = 0;
    const totals: number[] = [];
    let published = Promise.withResolvers<void>();
    stop = watchVisibleRefresh(
      async (signal) => {
        reads++;
        return (await get("stats", signal)).json<{ total: number }>();
      },
      (value) => {
        totals.push(value.total);
        published.resolve();
      },
      (refresh) => {
        invalidate = refresh;
        return () => { invalidate = () => {}; };
      },
      () => visible,
    );
    await published.promise;
    expect(totals).toEqual([52]);

    // Miss the bot uploads while hidden; returning to the visible page triggers a fresh read.
    visible = false;
    await f.db.exec(`WITH RECURSIVE rows(n) AS (VALUES(53) UNION ALL SELECT n+1 FROM rows WHERE n < 57)
      INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status)
      SELECT 'm' || n, 1, 'photo', 'file', 'm' || n, 'describing' FROM rows;`);
    invalidate();
    visible = true;
    published = Promise.withResolvers<void>();
    for (let i = 0; i < 10; i++) invalidate(); // focus, reconnect and upload notices may arrive together
    await published.promise;
    expect(totals).toEqual([52, 57]);
    expect(reads).toBe(2);

    expect(await (await get("analysis/result")).json<typeof snapshot>()).toEqual(snapshot);
    expect(await readShared()).toEqual(publicSnapshot);
    expect(f.jobs).toEqual([]);
  } finally {
    stop?.();
    f.close();
  }
});

test("stats invalidation during a read schedules one follow-up and cleanup ignores late responses", async () => {
  const first = Promise.withResolvers<number>();
  const late = Promise.withResolvers<number>();
  const readAgain = Promise.withResolvers<AbortSignal>();
  let invalidate = () => {};
  let reads = 0;
  const published: number[] = [];
  const stop = watchVisibleRefresh(
    (signal) => {
      if (++reads === 1) return first.promise;
      readAgain.resolve(signal);
      return late.promise;
    },
    (value) => published.push(value),
    (refresh) => {
      invalidate = refresh;
      return () => {};
    },
    () => true,
  );
  try {
    invalidate();
    invalidate();
    expect(reads).toBe(1);
    first.resolve(52);
    const signal = await readAgain.promise;
    expect(reads).toBe(2);
    stop();
    expect(signal.aborted).toBe(true);
    late.resolve(57);
    await Bun.sleep(0);
    expect(published).toEqual([52]);
  } finally {
    stop();
  }
});
