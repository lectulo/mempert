import { expect, test } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Job } from "../../src/queue";
import { LocalDatabase } from "../../src/runtime/db";
import { LocalQueues } from "../../src/runtime/queue";

const describeJob = (memeId: string): Job => ({ type: "describe", memeId });

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { release, waiting };
}

function fixture(photoWorkers: number | undefined) {
  const db = new LocalDatabase(":memory:", `${import.meta.dir}/../../migrations`);
  db.sqlite.exec("INSERT INTO users (id, role) VALUES (1, 'admin')");
  const seed = db.sqlite.query("INSERT INTO memes (id,user_id,kind,file_id,file_unique_id,status) VALUES (?,1,?,?,?,'describing')");
  const entered: { queue: string; message: Message<unknown>; hold: ReturnType<typeof gate> }[] = [];
  const queues = new LocalQueues(db.sqlite, async batch => {
    await Promise.all(batch.messages.map(message => {
      const hold = gate();
      entered.push({ queue: batch.queue, message, hold });
      return hold.waiting;
    }));
  }, undefined, undefined, photoWorkers);
  const ticks: Promise<void>[] = [];
  return {
    db: db.sqlite, queues, entered,
    jobs: queues.binding<Job>("memesave-jobs"),
    uploads: queues.binding("memesave-tgupload"),
    photo(id: string) { seed.run(id, "photo", id, id); },
    video(id: string) { seed.run(id, "video", id, id); },
    post(id: string, group: string | null, ...members: string[]) {
      db.sqlite.query("INSERT INTO posts (id,user_id,media_group_id) VALUES (?,1,?)").run(id, group);
      const insert = db.sqlite.query("INSERT INTO post_items (post_id,meme_id,position) VALUES (?,?,?)");
      members.forEach((member, index) => insert.run(id, member, index + 1));
    },
    async tick() {
      // Leave consumers blocked, but let the dispatcher run a full event-loop turn.
      ticks.push(queues.tick());
      await nextTurn();
    },
    async close() {
      const stopped = queues.stop();
      await nextTurn();
      for (const { hold } of entered) hold.release();
      await stopped;
      await Promise.all(ticks);
      db.close();
    },
  };
}

for (const workers of [undefined, 3]) {
  test(`photo delivery uses ${workers === undefined ? "one slot by default" : `${workers} configured slots`} and frees a slot after ack`, async () => {
    const f = fixture(workers);
    const slots = workers ?? 1;
    try {
      for (let i = 0; i <= slots; i++) {
        f.photo(`photo-${i}`);
        f.post(`post-${i}`, null, `photo-${i}`);
        await f.jobs.send(describeJob(`photo-${i}`));
      }

      for (let i = 0; i <= slots; i++) await f.tick();
      expect(f.entered).toHaveLength(slots);
      expect(new Set(f.entered.map(({ message }) => message.id)).size).toBe(slots);

      f.entered[0].message.ack();
      f.entered[0].hold.release();
      await nextTurn();
      await f.tick();
      expect(f.entered).toHaveLength(slots + 1);
      expect(new Set(f.entered.map(({ message }) => message.id)).size).toBe(slots + 1);
    } finally { await f.close(); }
  });
}

test("nonphoto work stays exclusive across jobs and uploads even with spare photo slots", async () => {
  const f = fixture(3);
  try {
    f.photo("first"); f.video("clip"); f.photo("last");
    await f.jobs.send(describeJob("first"));
    await f.jobs.send(describeJob("clip"));
    await f.jobs.send(describeJob("last"));
    await f.uploads.send({ userId: 1, memeIds: ["clip"] });
    await f.jobs.send({ type: "batch_poll" });
    const expected = [
      { queue: "memesave-jobs", body: describeJob("first") },
      { queue: "memesave-jobs", body: describeJob("clip") },
      { queue: "memesave-jobs", body: describeJob("last") },
      { queue: "memesave-tgupload", body: { userId: 1, memeIds: ["clip"] } },
      { queue: "memesave-jobs", body: { type: "batch_poll" } },
    ];

    for (const [i, delivery] of expected.entries()) {
      await f.tick();
      await f.tick();
      expect(f.entered).toHaveLength(i + 1);
      const { queue, message, hold } = f.entered[i];
      expect({ queue, body: message.body }).toEqual(delivery);
      hold.release();
      await nextTurn();
    }
    expect(f.db.query("SELECT id FROM _runtime_queue").all()).toEqual([]);
  } finally { await f.close(); }
});

test("same-meme photo jobs cannot overlap, but an unrelated photo can use a free slot", async () => {
  const f = fixture(3);
  try {
    f.photo("a"); f.photo("b");
    const first = describeJob("a");
    const sameMeme = { type: "finish", memeId: "a" } satisfies Job;
    const other = describeJob("b");
    for (const job of [first, sameMeme, other]) await f.jobs.send(job);

    for (let i = 0; i < 3; i++) await f.tick();
    expect(f.entered.map(({ message }) => message.body)).toEqual([first, other]);
    f.entered[0].hold.release();
    await nextTurn();
    await f.tick();
    expect(f.entered.map(({ message }) => message.body)).toEqual([first, other, sameMeme]);
  } finally { await f.close(); }
});

for (const overlapping of [false, true]) {
  test(`photo jobs for ${overlapping ? "overlapping albums" : "the same album"} cannot overlap`, async () => {
    const f = fixture(3);
    try {
      f.photo("a"); f.photo("b");
      if (overlapping) {
        f.photo("shared");
        f.post("left", "left", "a", "shared");
        f.post("right", "right", "shared", "b");
      } else f.post("album", "album", "a", "b");
      const first = describeJob("a");
      const conflicting = { type: "finish", memeId: "b" } satisfies Job;
      await f.jobs.send(first);
      await f.jobs.send(conflicting);

      await f.tick();
      await f.tick();
      expect(f.entered.map(({ message }) => message.body)).toEqual([first]);

      f.entered[0].hold.release();
      await nextTurn();
      await f.tick();
      expect(f.entered.map(({ message }) => message.body)).toEqual([first, conflicting]);
    } finally { await f.close(); }
  });
}

test("stop waits for all claimed photos, preserves a retry, and does not claim another photo", async () => {
  const f = fixture(2);
  try {
    for (const id of ["a", "b", "c"]) {
      f.photo(id);
      await f.jobs.send(describeJob(id));
    }
    await f.tick();
    await f.tick();
    expect(f.entered).toHaveLength(2);

    let stopped = false;
    const stopping = f.queues.stop().then(() => { stopped = true; });
    const [ack, retry] = f.entered;
    ack.hold.release(); // implicit ack
    await f.tick();
    expect(stopped).toBe(false);
    expect(f.entered).toHaveLength(2);

    const beforeRetry = Date.now();
    retry.message.retry({ delaySeconds: 60 });
    retry.hold.release();
    await stopping;
    const pending = f.db.query<{ id: string; attempts: number; available: number; lease: string | null; lease_until: number | null }, []>(
      "SELECT id, attempts, available, lease, lease_until FROM _runtime_queue ORDER BY attempts",
    ).all();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ attempts: 0, lease: null, lease_until: null });
    expect(pending[1]).toMatchObject({ id: retry.message.id, attempts: 1, lease: null, lease_until: null });
    expect(pending[1].available).toBeGreaterThanOrEqual(beforeRetry + 60_000);

    const retried: Message<unknown>[] = [];
    const resumed = new LocalQueues(f.db, async batch => { retried.push(...batch.messages); }, undefined, undefined, 2);
    try {
      await resumed.tick(); // Only the unclaimed photo is due yet.
      expect(retried.map(({ id, attempts }) => ({ id, attempts }))).toEqual([{ id: pending[0].id, attempts: 1 }]);
      f.db.query("UPDATE _runtime_queue SET available=0 WHERE id=?").run(retry.message.id);
      await resumed.tick();
      expect(retried[1]).toMatchObject({ id: retry.message.id, attempts: 2, body: retry.message.body });
      expect(f.db.query("SELECT id FROM _runtime_queue").all()).toEqual([]);
    } finally { await resumed.stop(); }
  } finally { await f.close(); }
});
