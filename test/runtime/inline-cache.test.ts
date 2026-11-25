import { expect, mock, test } from "bun:test";
import type { Env } from "../../src/env";
import { createDatabase } from "../../src/runtime/db";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { cachedFastSearch } = await import("../../src/search/inline");

test("shared cached fast search only hydrates rows still owned by the requester", async () => {
  const db = createDatabase(":memory:", `${import.meta.dir}/../../migrations`);
  try {
    db.sqlite.exec("INSERT INTO users (id, role) VALUES (81, 'user'), (82, 'user')");
    const insert = db.sqlite.query("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES (?, ?, 'photo', ?, ?, ?)");
    insert.run("first", 81, "first", "first", "ready");
    insert.run("last", 81, "last", "last", "ready");
    insert.run("detached", -81, "detached", "detached", "failed");
    insert.run("foreign", 82, "foreign", "foreign", "ready");

    const env = {
      DB: db,
      MEDIA: { get: async () => ({
        uploaded: new Date(),
        json: async () => ["detached", "last", "foreign", "first"],
      }) },
    } as unknown as Env;

    expect((await cachedFastSearch(env, 81, "test query")).map((m) => m.id)).toEqual(["last", "first"]);
  } finally {
    db.close();
  }
});
