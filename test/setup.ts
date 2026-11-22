import { applyD1Migrations, env } from "cloudflare:test";
import { saveAIConfig } from "../src/aimodels";

await applyD1Migrations(env.DB, (env as any).TEST_MIGRATIONS);
const error = await saveAIConfig(env, {
  action: "provider", id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", key: "k",
});
if (error) throw new Error(error);
