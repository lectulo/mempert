import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./test/wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, BOT_TOKEN: "1:test", WEBHOOK_SECRET: "s", OPENROUTER_API_KEY: "k", ENCRYPTION_KEY: "e", TG_CLIENT_SECRET: "cs", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", SCRAPER_API_KEY: "sk" },
        },
      }),
    ],
    test: { include: ["test/*.test.ts"], setupFiles: ["./test/setup.ts"], maxWorkers: 1 },
  };
});
