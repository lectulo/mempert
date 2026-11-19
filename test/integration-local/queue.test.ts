import { expect, test } from "bun:test";
import { fixture } from "./fixture";
import { LocalQueues } from "../../src/runtime/queue";

test("persisted batch delays and retry attempts survive reopening real SQLite", async () => {
  const f = await fixture();
  try {
    const producer = new LocalQueues(f.db.sqlite, async () => { throw new Error("producer cannot consume"); });
    await producer.binding("memesave-jobs").sendBatch([
      { body: { type: "hash", memeId: "now" } },
      { body: { type: "source_meta", memeId: "later" }, delaySeconds: 43200 },
    ]);
    await f.reopen();
    const seen: { body: unknown; attempts: number; queue: string }[] = [];
    const consumer = new LocalQueues(f.db.sqlite, async batch => {
      for (const message of batch.messages) {
        seen.push({ body: message.body, attempts: message.attempts, queue: batch.queue });
        if (message.attempts === 1) message.retry({ delaySeconds: 60 }); else message.ack();
      }
    });
    await consumer.tick(); await consumer.tick();
    expect(seen).toEqual([{ body: { type: "hash", memeId: "now" }, attempts: 1, queue: "memesave-jobs" }]);
    const rows = f.db.sqlite.query("SELECT body, available FROM _runtime_queue ORDER BY available").all() as { body: string; available: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].available).toBeGreaterThan(Date.now()+50_000);
    expect(rows[1].available).toBeGreaterThan(Date.now()+43_000_000);
    await consumer.stop();
    await f.reopen();
    // Advance the persisted due time, not a wall-clock sleep or background polling.
    f.db.sqlite.query("UPDATE _runtime_queue SET available = 0 WHERE json_extract(body, '$.memeId') = 'now'").run();
    const restarted = new LocalQueues(f.db.sqlite, async batch => {
      expect(batch.messages[0].attempts).toBe(2); batch.ackAll();
    });
    await restarted.tick(); await restarted.stop();
    expect(f.db.sqlite.query("SELECT body FROM _runtime_queue").all()).toEqual([{ body: JSON.stringify({ type: "source_meta", memeId: "later" }) }]);
  } finally { f.close(); }
});

test("expired crash lease is reclaimed, live lease is not, upload routing is preserved", async () => {
  const f = await fixture();
  try {
    const queues = new LocalQueues(f.db.sqlite, async () => {});
    await queues.binding("memesave-tgupload").send({ userId: 101, memeIds: ["a"] });
    // Materialize the state of a worker killed after claim without running a timer.
    f.db.sqlite.query("UPDATE _runtime_queue SET attempts=1, lease='dead-worker', lease_until=?").run(Date.now()+60_000);
    await f.reopen();
    let calls = 0;
    const restarted = new LocalQueues(f.db.sqlite, async batch => {
      calls++;
      expect(batch.queue).toBe("memesave-tgupload");
      expect(batch.messages[0].body).toEqual({ userId: 101, memeIds: ["a"] });
      expect(batch.messages[0].attempts).toBe(2);
      batch.ackAll();
    });
    await restarted.tick(); expect(calls).toBe(0);
    f.db.sqlite.query("UPDATE _runtime_queue SET lease_until=0").run();
    await restarted.tick(); await restarted.tick(); await restarted.stop();
    expect(calls).toBe(1);
    expect(f.db.sqlite.query("SELECT * FROM _runtime_queue").all()).toEqual([]);
  } finally { f.close(); }
});
