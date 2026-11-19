import type { Database } from "bun:sqlite";

type Row = { id: string; queue: string; body: string; attempts: number; created: number };
type Consumer = (batch: MessageBatch<unknown>) => Promise<unknown>;
const delayMs = (seconds = 0) => {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200) throw new Error("Queue delay must be between 0 and 43200 seconds");
  return seconds * 1000;
};
const encode = (body: unknown) => {
  const value = JSON.stringify(body);
  if (value === undefined) throw new Error("Queue body must be JSON serializable");
  return value;
};

/** Durable at-least-once delivery. One shared consumer slot for both queues. */
export class LocalQueues {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  constructor(private db: Database, private consume: Consumer, private leaseMs = 60_000, private maxAttempts = 50) {
    db.exec(`CREATE TABLE IF NOT EXISTS _runtime_queue (
      id TEXT PRIMARY KEY, queue TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL,
      available INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER,
      dead INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE INDEX IF NOT EXISTS _runtime_queue_ready ON _runtime_queue(dead,available,lease_until);`);
  }
  binding<T>(name: string): Queue<T> {
    const send = async (body: T, opts?: QueueSendOptions) => {
      const now = Date.now();
      this.db.query("INSERT INTO _runtime_queue(id,queue,body,created,available) VALUES(?,?,?,?,?)")
        .run(crypto.randomUUID(), name, encode(body), now, now + delayMs(opts?.delaySeconds));
    };
    return { send, sendBatch: async (messages: Iterable<MessageSendRequest<T>>, opts?: QueueSendBatchOptions) => {
      this.db.transaction(() => {
        for (const m of messages) {
          this.db.query("INSERT INTO _runtime_queue(id,queue,body,created,available) VALUES(?,?,?,?,?)")
            .run(crypto.randomUUID(), name, encode(m.body), Date.now(), Date.now() + delayMs(m.delaySeconds ?? opts?.delaySeconds));
        }
      })();
    } } as unknown as Queue<T>;
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick(); }, 250);
    void this.tick();
  }
  async tick() {
    if (this.stopping || this.active) return;
    this.active = this.deliver().catch(e => console.error("queue consumer", e));
    try { await this.active; } finally { this.active = undefined; }
  }
  private async deliver() {
    const now = Date.now(), lease = crypto.randomUUID();
    const row = this.db.transaction(() => {
      const r = this.db.query(`SELECT * FROM _runtime_queue WHERE dead=0 AND available<=?
        AND (lease_until IS NULL OR lease_until<=?) ORDER BY available,created LIMIT 1`).get(now, now) as Row | null;
      if (!r) return null;
      this.db.query("UPDATE _runtime_queue SET lease=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(lease, now + this.leaseMs, r.id);
      return { ...r, attempts: r.attempts + 1 };
    }).immediate();
    if (!row) return;
    // Heartbeat prevents a long Telegram upload from being redelivered while it is still running.
    const heartbeat = setInterval(() => {
      try { this.db.query("UPDATE _runtime_queue SET lease_until=? WHERE id=? AND lease=?").run(Date.now() + this.leaseMs, row.id, lease); }
      catch (e) { console.error("queue lease", e); }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    let action: "ack" | "retry" | undefined, delay = 0, error: string | null = null, dead = false;
    const ack = () => { action ??= "ack"; };
    const retry = (opts?: QueueRetryOptions) => { if (!action) { action = "retry"; delay = opts?.delaySeconds ?? Math.min(30 * row.attempts, 3600); } };
    try {
      const message = { id: row.id, timestamp: new Date(row.created), body: JSON.parse(row.body), attempts: row.attempts, ack, retry,
        deadLetter(reason: unknown) { dead = true; error = String(reason); } };
      await this.consume({ queue: row.queue, messages: [message], ackAll: ack, retryAll: retry } as unknown as MessageBatch<unknown>);
      action ??= "ack"; // Workers implicitly acknowledge successful batches.
    } catch (e) { error = String(e); retry(); }
    finally { clearInterval(heartbeat); }
    if (action === "ack" && !dead) this.db.query("DELETE FROM _runtime_queue WHERE id=? AND lease=?").run(row.id, lease);
    else this.db.query("UPDATE _runtime_queue SET available=?,lease=NULL,lease_until=NULL,dead=?,error=? WHERE id=? AND lease=?")
      .run(Date.now() + delay * 1000, dead || row.attempts >= this.maxAttempts ? 1 : 0, error, row.id, lease);
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer); this.timer = undefined;
    await this.active;
  }
}
