import { DESCRIBE_MODELS } from "./config";
import type { User } from "./db";
import type { Env } from "./env";
import type { AssistantMessage, ChatMessage } from "./openrouter";
import { recordSpend, type Spend } from "./spend";

type Settings = Pick<Env, "PHOTO_API_BASE_URL" | "PHOTO_API_KEY" | "PHOTO_MODEL">;

/** Instance credentials are separate from both shared and per-user OpenRouter keys. */
export function photoProvider(vars: Settings) {
  const base = vars.PHOTO_API_BASE_URL?.trim(), key = vars.PHOTO_API_KEY?.trim(), model = vars.PHOTO_MODEL?.trim();
  if (!base && !key && !model) return null;
  if (!base || !key || !model) throw new Error("Set PHOTO_API_BASE_URL, PHOTO_API_KEY and PHOTO_MODEL together");
  const url = URL.canParse(base) ? new URL(base) : null;
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("PHOTO_API_BASE_URL must be an HTTP(S) API base URL without credentials, query or fragment");
  }
  return { endpoint: url.href.replace(/\/+$/, "") + "/chat/completions", key, model };
}

export function photoModel(env: Env, user: Pick<User, "openrouter_key" | "describe_tier">) {
  return (!user.openrouter_key && env.PHOTO_MODEL?.trim()) || DESCRIBE_MODELS[user.describe_tier];
}

export async function providerDescription(env: Env, provider: NonNullable<ReturnType<typeof photoProvider>>,
  body: { messages: ChatMessage[]; response_format: object }, spend: Spend): Promise<AssistantMessage> {
  const res = await fetch(provider.endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: provider.model, messages: body.messages, response_format: body.response_format }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Photo provider /chat/completions returned HTTP ${res.status}`);
  }
  const data = await res.json<{ choices?: { message?: AssistantMessage }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } }>();
  const message = data.choices?.[0]?.message;
  if (!message || (typeof message.content !== "string" && !message.refusal)) throw new Error("Photo provider returned no description");
  await recordSpend(env, spend, provider.model, "global", data.usage ?? {});
  return message;
}
