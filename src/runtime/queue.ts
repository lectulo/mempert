import type { Database } from "bun:sqlite";

type Row = { id: string; queue: string; body: string; attempts: number; created: number };
type Consumer = (batch: MessageBatch<unknown>) => Promise<unknown>;
type Claim = { row: Row; lease: string; key: string | null }; // null means exclusive
const delayMs = (seconds = 0) => {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200) throw new Error("Queue delay must be between 0 and 43200 seconds");
  return seconds * 1000;
};
const encode = (body: unknown) => {
  const value = JSON.stringify(body);
  if (value === undefined) throw new Error("Queue body must be JSON serializable");
  return value;
};

/** Durable at-least-once delivery. Only ordinary photo processing can share the consumer slots. */
export class LocalQueues {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, { key: Claim["key"]; task: Promise<void> }>();
  private stopping = false;
  constructor(private db: Database, private consume: Consumer, private leaseMs = 60_000, private maxAttempts = 50, private photoWorkers = 1) {
    db.exec(`CREATE TABLE IF NOT EXISTS _runtime_queue (
      id TEXT PRIMARY KEY, queue TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL,
      available INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER, lease_key TEXT,
      dead INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE INDEX IF NOT EXISTS _runtime_queue_order ON _runtime_queue(available,created) WHERE dead=0;
      CREATE INDEX IF NOT EXISTS _runtime_queue_leased ON _runtime_queue(lease_until) WHERE dead=0 AND lease_until IS NOT NULL;
      DROP INDEX IF EXISTS _runtime_queue_ready;`);
    db.transaction(() => {
      if (!db.query("SELECT 1 FROM pragma_table_info('_runtime_queue') WHERE name='lease_key'").get())
        db.exec("ALTER TABLE _runtime_queue ADD COLUMN lease_key TEXT");
    }).immediate();
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
    if (this.stopping || this.active.size >= this.photoWorkers) return;
    let claims: Claim[];
    try {
      claims = this.claimReady();
    } catch (e) { console.error("queue claim", e); return; }
    await Promise.all(claims.map(claim => {
      const task = Promise.resolve().then(() => this.deliver(claim))
        .catch(e => console.error("queue consumer", e)).finally(() => { this.active.delete(claim.row.id); });
      this.active.set(claim.row.id, { key: claim.key, task });
      return task;
    }));
  }

  private photoKey(row: Row): string | null {
    if (this.photoWorkers === 1 || row.queue !== "memesave-jobs") return null;
    let body: { type?: string; memeId?: string } | null;
    try { body = JSON.parse(row.body); } catch { return null; }
    if (!body || !["embed", "describe", "finish"].includes(body.type ?? "") || typeof body.memeId !== "string") return null;
    // Album work can touch other members, and albums can share a meme. Keep it exclusive
    // rather than building locks for all the members (which can be large for comics).
    const photo = this.db.query(`SELECT 1 FROM memes m WHERE id=? AND kind='photo' AND import_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM post_items i JOIN posts p ON p.id=i.post_id
        WHERE i.meme_id=m.id AND p.media_group_id IS NOT NULL)`).get(body.memeId);
    return photo ? body.memeId : null;
  }

  private claimReady(): Claim[] {
    return this.db.transaction(() => {
      const now = Date.now();
      const leased = new Map<string, Claim["key"]>(this.db.query<{ id: string; lease_key: string | null }, [number]>(
        "SELECT id,lease_key FROM _runtime_queue WHERE dead=0 AND lease_until>?",
      ).all(now).map(r => [r.id, r.lease_key]));
      // Don't reclaim an in-process delivery on heartbeat delay, even if its SQLite lease expired.
      for (const [id, { key }] of this.active) leased.set(id, key);
      const slots = this.photoWorkers - leased.size;
      if (slots <= 0) return [];
      const busy = new Set<string>();
      for (const key of leased.values()) {
        if (key === null) return [];
        busy.add(key);
      }

      const ready = this.db.query<Row & { available: number; position: number }, [number, number, number, number, number]>(
        `SELECT id,queue,body,attempts,created,available,rowid AS position FROM _runtime_queue
        WHERE dead=0 AND available<=? AND (lease_until IS NULL OR lease_until<=?) AND (available,created,rowid)>(?,?,?)
        ORDER BY available,created,rowid LIMIT 1`,
      );
      const claims: Claim[] = [];
      let cursor: [number, number, number] = [-Infinity, -Infinity, 0];
      for (let row; claims.length < slots && (row = ready.get(now, now, ...cursor));) {
        cursor = [row.available, row.created, row.position];
        if (leased.has(row.id)) continue;
        const key = this.photoKey(row);
        // Exclusive work is a barrier: never jump it to claim another ready photo.
        if (key === null && (leased.size || claims.length)) break;
        if (key !== null && busy.has(key)) continue;
        const lease = crypto.randomUUID();
        this.db.query("UPDATE _runtime_queue SET lease=?,lease_until=?,lease_key=?,attempts=attempts+1 WHERE id=?")
          .run(lease, Date.now() + this.leaseMs, key, row.id);
        claims.push({ row: { ...row, attempts: row.attempts + 1 }, lease, key });
        if (key === null) break;
        busy.add(key);
      }
      return claims;
    }).immediate();
  }

  private async deliver({ row, lease }: Claim) {
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
    else this.db.query("UPDATE _runtime_queue SET available=?,lease=NULL,lease_until=NULL,lease_key=NULL,dead=?,error=? WHERE id=? AND lease=?")
      .run(Date.now() + delay * 1000, dead || row.attempts >= this.maxAttempts ? 1 : 0, error, row.id, lease);
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer); this.timer = undefined;
    await Promise.all([...this.active.values()].map(({ task }) => task));
  }
}
