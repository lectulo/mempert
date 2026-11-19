-- Business outbox: enqueue is at least once; stage gen/status guards handle duplicates.
CREATE TABLE batch_continuations (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE batch_spend_receipts (
  batch_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
ALTER TABLE imports ADD COLUMN submission_started INTEGER NOT NULL DEFAULT 0;
