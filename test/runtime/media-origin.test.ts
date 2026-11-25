import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicWebAppUrl, telegramMediaOrigin } from "../../src/telegramurl";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { createEnvironment } = await import("../../src/runtime/env");

const vars = {
  PUBLIC_URL: "http://localhost:3000/", BOT_TOKEN: "1:fixture", ENCRYPTION_KEY: "fixture-key",
  WORKER_SECRET: "fixture-secret", ADMIN_ID: "1", DB_PATH: ":memory:", MIGRATIONS_DIR: `${import.meta.dir}/../../migrations`,
};

test("the runtime canonicalizes MEDIA_URL but leaves the web app origin local", async () => {
  const root = mkdtempSync(join(tmpdir(), "mempert-media-origin-"));
  try {
    for (const [setting, expected] of [["  HTTPS://Media.Example:443/  ", "https://media.example"], [" \t ", "http://localhost:3000"], [undefined, "http://localhost:3000"]]) {
      const { env, storage, db } = await createEnvironment({ ...vars, MEDIA_URL: setting, MEDIA_ROOT: root });
      try {
        expect(env.MEDIA_URL).toBe(expected);
        expect(env.PUBLIC_URL).toBe("http://localhost:3000");
        expect(publicWebAppUrl(env)).toBeUndefined();
        expect(telegramMediaOrigin(env)).toBe(expected?.startsWith("https:") ? expected : null);
      } finally { await storage.close(); db.close(); }
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("the runtime rejects explicit unusable MEDIA_URL values, even ones URL parsing would normalize", async () => {
  for (const MEDIA_URL of [
    "http://media.example", "https://user:pass@media.example", "https://@media.example", "https://media.example/dir",
    "https://media.example/%2e", "https://media.example/dir/..", "https://media.example//", "https://media.example/?",
    "https://media.example#", "https://media.example\\", "https:///media.example", "https://media.\texample",
    "https://localhost.", "https://a.localhost.", "https://app", "https://app.internal", "https://app.local.",
    "https://127.2.3.4", "https://0x7f000001", "https://10.1", "https://169.254.1.1", "https://172.31.0.1",
    "https://192.168.0.1", "https://0.0.0.0", "https://[::]", "https://[::1]", "https://[::ffff:127.0.0.1]",
    "https://[fd00::1]", "https://[fe80::1]",
  ]) {
    expect(telegramMediaOrigin({ MEDIA_URL, PUBLIC_URL: "https://app.example" })).toBeNull();
    await expect(createEnvironment({ ...vars, MEDIA_URL })).rejects.toThrow(/MEDIA_URL must be a public HTTPS origin/);
  }
});

test("Telegram media uses a usable PUBLIC_URL fallback and accepts public IP literals", () => {
  expect(telegramMediaOrigin({ PUBLIC_URL: "https://App.Example/", MEDIA_URL: " " })).toBe("https://app.example");
  expect(telegramMediaOrigin({ PUBLIC_URL: "https://8.8.8.8:8443/" })).toBe("https://8.8.8.8:8443");
  expect(telegramMediaOrigin({ PUBLIC_URL: "https://[2606:4700::1111]/" })).toBe("https://[2606:4700::1111]");
});
