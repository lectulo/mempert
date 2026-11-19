import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { LocalQueues } from "../../src/runtime/queue";

test("queues share one slot, delay and explicit retry survive implicit batch ack", async () => {
  const db = new Database(":memory:");
  const seen: string[] = [];
  const q = new LocalQueues(db, async batch => {
    seen.push(batch.queue);
    if (batch.messages[0].attempts === 1) batch.messages[0].retry({ delaySeconds: 60 });
    else batch.ackAll();
  });
  await q.binding("jobs").send({ n: 1 }); await q.binding("uploads").send({ n: 2 });
  await q.tick(); await q.tick();
  expect(seen).toEqual(["jobs", "uploads"]);
  expect(db.query("SELECT count(*) AS n FROM _runtime_queue").get()).toEqual({ n: 2 });
  await q.tick(); expect(seen.length).toBe(2);
  db.exec("UPDATE _runtime_queue SET available=0");
  await q.tick(); await q.tick();
  expect(db.query("SELECT count(*) AS n FROM _runtime_queue").get()).toEqual({ n: 0 });
  await q.stop(); db.close();
});

test("expired lease recovers, thrown batch is retried and finally goes to DLQ", async () => {
  const db = new Database(":memory:");
  const q = new LocalQueues(db, async () => { throw new Error("offline"); }, 1000, 2);
  await q.binding("jobs").send({});
  db.exec("UPDATE _runtime_queue SET lease='crashed',lease_until=0");
  await q.tick();
  expect((db.query("SELECT attempts FROM _runtime_queue").get() as any).attempts).toBe(1);
  db.exec("UPDATE _runtime_queue SET available=0"); await q.tick();
  expect((db.query("SELECT dead,error FROM _runtime_queue").get() as any)).toEqual({ dead: 1, error: "Error: offline" });
  await q.tick(); await q.stop(); db.close();
});

test("explicit ack wins over a later consumer error; sendBatch is atomic", async () => {
  const db = new Database(":memory:");
  const q = new LocalQueues(db, async batch => { batch.messages[0].ack(); throw new Error("after ack"); });
  await q.binding("jobs").sendBatch([{ body: {} }, { body: {}, delaySeconds: 60 }]);
  await Promise.all([q.tick(), q.tick()]);
  expect((db.query("SELECT count(*) AS n FROM _runtime_queue").get() as any).n).toBe(1);
  await q.stop(); db.close();
});

test("heartbeat fences a long job against a second consumer", async () => {
  const db = new Database(":memory:");
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const waiting = new Promise<void>(r => { release = r; });
  const first = new LocalQueues(db, async () => { entered(); await waiting; }, 90);
  let duplicates = 0;
  const second = new LocalQueues(db, async () => { duplicates++; }, 90);
  await first.binding("jobs").send({});
  const running = first.tick(); await started;
  await Bun.sleep(200); await second.tick();
  expect(duplicates).toBe(0);
  release(); await running; await first.stop(); await second.stop(); db.close();
});

test("per-message batch delay overrides batch delay up to twelve hours", async () => {
  const db = new Database(":memory:");
  const q = new LocalQueues(db, async () => {});
  const now = Date.now();
  await q.binding("jobs").sendBatch([{ body: 1, delaySeconds: 43200 }, { body: 2, delaySeconds: 0 }, { body: 3 }], { delaySeconds: 60 });
  const rows = db.query("SELECT body,available FROM _runtime_queue ORDER BY body").all() as {body:string,available:number}[];
  expect(rows[0].available - now).toBeGreaterThanOrEqual(43200_000);
  expect(rows[1].available - now).toBeLessThan(1000);
  expect(rows[2].available - now).toBeGreaterThanOrEqual(60_000);
  await q.stop(); db.close();
});

test("queue bodies and attempts survive reopening SQLite after an expired lease", async () => {
  mkdirSync(".compat-spike/queue-tests", {recursive:true});
  const path = `.compat-spike/queue-tests/${crypto.randomUUID()}.sqlite`;
  const old = new Database(path);
  const before = new LocalQueues(old, async () => {});
  await before.binding("memesave-tgupload").send({ userId: 1, memeIds: ["x"] });
  old.exec("UPDATE _runtime_queue SET lease='dead-process',lease_until=0,attempts=2");
  old.close();
  const db = new Database(path);
  let received = false;
  const recovered = new LocalQueues(db, async batch => {
    expect(batch.queue).toBe("memesave-tgupload"); expect(batch.messages[0].attempts).toBe(3);
    expect(batch.messages[0].body).toEqual({userId:1,memeIds:["x"]}); received = true;
  });
  await recovered.tick(); expect(received).toBe(true); await recovered.stop(); db.close();
});

test("optional deadLetter preserves final payload, attempts and error even after ack", async () => {
  const db = new Database(":memory:");
  const q = new LocalQueues(db, async batch => {
    const message = batch.messages[0] as Message<unknown> & {deadLetter(error:unknown):void};
    message.deadLetter(new Error("permanent failure")); message.ack();
  });
  await q.binding("jobs").send({type:"describe",memeId:"broken"}); await q.tick();
  const row = db.query("SELECT body,attempts,error,dead FROM _runtime_queue").get();
  expect(row).toEqual({body:JSON.stringify({type:"describe",memeId:"broken"}),attempts:1,error:"Error: permanent failure",dead:1});
  await q.tick(); expect(db.query("SELECT attempts FROM _runtime_queue").get()).toEqual({attempts:1});
  await q.stop(); db.close();
});
