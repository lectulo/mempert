import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { saveAIConfig } from "../src/aimodels";
import { apiKey, decrypt, encrypt, keyFor, setUserKey } from "../src/userkey";

describe("user OpenRouter key", () => {
  it("encrypts round trip", async () => {
    const sealed = await encrypt("secret", "sk-or-1");
    expect(sealed).not.toContain("sk-or");
    expect(await decrypt("secret", sealed)).toBe("sk-or-1");
  });

  it("uses the configured provider for new work and retains user keys for accepted batches", async () => {
    await env.DB.prepare("INSERT INTO users (id, role) VALUES (11, 'user')").run();
    expect(await saveAIConfig(env, { action: "provider", id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", key: "sk-or-instance" })).toBeNull();
    await setUserKey(env, 11, "sk-or-user");
    expect(await apiKey(env, 11)).toEqual({ key: "sk-or-instance", source: "global" });
    expect(await keyFor(env, 11, "global")).toBe("sk-or-instance");
    expect(await keyFor(env, 11, "user")).toBe("sk-or-user");
    await setUserKey(env, 11, null);
    expect(await keyFor(env, 11, "user")).toBeNull();
  });
});
