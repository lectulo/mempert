import { expect, test } from "bun:test";
import { saveAIConfig } from "../../src/aimodels";
import type { Env } from "../../src/env";
import { createDatabase } from "../../src/runtime/db";
import { apiKey, keyFor, setUserKey } from "../../src/userkey";

test("shared OpenRouter credentials apply to new work, but accepted batches retain their own key source", async () => {
  const db = createDatabase(":memory:", `${import.meta.dir}/../../migrations`);
  try {
    const env = { DB: db, ENCRYPTION_KEY: "fixture-only" } as unknown as Env;
    db.sqlite.exec("INSERT INTO users (id, role) VALUES (11, 'user')");
    const provider = { action: "provider", id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" };
    expect(await saveAIConfig(env, { ...provider, key: "fixture-first-shared" })).toBeNull();
    await setUserKey(env, 11, "fixture-personal");
    expect(await apiKey(env, 11)).toEqual({ key: "fixture-first-shared", source: "global" });
    expect(await saveAIConfig(env, { ...provider, key: "fixture-rotated-shared" })).toBeNull();
    expect(await apiKey(env, 11)).toEqual({ key: "fixture-rotated-shared", source: "global" });
    expect(await keyFor(env, 11, "global")).toBe("fixture-rotated-shared");
    expect(await keyFor(env, 11, "user")).toBe("fixture-personal");
    await setUserKey(env, 11, null);
    expect(await keyFor(env, 11, "user")).toBeNull();
  } finally { db.close(); }
});
