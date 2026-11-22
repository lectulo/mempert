import { getAIProvider, resolveAI, seededAIBase } from "./aimodels";
import { customAIPost } from "./aiprovidertransport";
import { EMBED_DIMS, MODELS } from "./config";
import type { Env } from "./env";
import { esc } from "./i18n";
import { outboundFetch } from "./outboundproxy";
import { hasReportedUsage, logMissingUsage, recordSpend, type Spend, type TokenPrices, type Usage } from "./spend";
import { keyFor } from "./userkey";

const BASE = "https://openrouter.ai/api/v1";
type Workload = Parameters<typeof resolveAI>[1];
type Route = NonNullable<Awaited<ReturnType<typeof resolveAI>>>;

export async function requireAIRoute(env: Env, workload: Workload): Promise<Route> {
  const route = await resolveAI(env, workload);
  if (!route) throw new Error(`AI route unavailable: ${workload}`);
  return route;
}

/** Embeddings and batches are OpenRouter-specific and never use a chat provider's credentials. */
export async function openRouterKey(env: Env): Promise<string> {
  const provider = await getAIProvider(env, "openrouter");
  if (!provider?.key) throw new Error("OpenRouter provider credentials are not configured");
  return provider.key;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// reasoning_details must be sent back unchanged for tool calling with reasoning models.
export type AssistantMessage = { role: "assistant"; content: string | null; refusal?: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] };

export type ChatMessage =
  | { role: "system" | "user"; content: string | Part[] }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

/** An OpenRouter error; `reason` is safe to show to the user. */
export class OpenRouterError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/** The error as HTML for a bot message: OpenRouter errors only, other errors are internal. */
export const errorNote = (e: unknown) => (e instanceof OpenRouterError ? `\n<code>${esc(e.reason)}</code>` : "");

/** A non-JSON body may be a proxy error page; never put its text in an error. */
async function parse(res: Response): Promise<any> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

function fail(path: string, status: number, detail = "request failed"): never {
  throw new OpenRouterError(`OpenRouter ${path} ${status}: ${detail}`, `OpenRouter ${status}: ${detail}`);
}

/** Rate limits and provider errors: worth one more try. */
const transient = (status: number) => status === 408 || status === 429 || status >= 500;

async function post(env: Env, route: { providerId: string; key: string; baseUrl: string }, path: string,
  body: { model: string } & Record<string, unknown>, spend: Spend, signal?: AbortSignal, prices?: TokenPrices, retries = 1) {
  const openRouter = route.providerId === "openrouter";
  const pinned = seededAIBase(route.providerId);
  if (pinned && pinned !== route.baseUrl) throw new Error("AI provider destination is fixed");
  const json = JSON.stringify(openRouter ? { ...body, user: String(spend.userId) } : body);
  const res = pinned ? await (openRouter ? outboundFetch : fetch)(pinned + path, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${route.key}`,
      "Content-Type": "application/json",
      ...(openRouter && { "HTTP-Referer": "https://github.com/cofob/memesave-bot", "X-Title": "memesave-bot" }),
    },
    body: json,
    signal,
  }) : await customAIPost(route.baseUrl, json, route.key, signal);
  const data = await parse(res);
  // A provider error can also come with status 200, inside the choice.
  const choice = data?.choices?.[0];
  const error = data?.error ?? choice?.error;
  const invalid = !data || (path === "/chat/completions"
    ? !choice?.message || typeof choice.message !== "object" || Array.isArray(choice.message)
    : !Array.isArray(data.data));
  const failed = !res.ok || error != null || invalid;
  // The same attempt can report usage at multiple levels. Pick one, preferring explicit cost.
  const reports: Usage[] = [data?.usage, data?.error?.usage, choice?.error?.usage, choice?.usage].filter(hasReportedUsage);
  const usage = reports.find((report) => hasReportedUsage({ cost: report?.cost })) ?? reports[0];
  if (!failed || usage) await recordSpend(env, spend, body.model, "global", usage, prices);
  else logMissingUsage(spend.kind);
  if (failed) {
    const code = typeof error?.code === "number" || typeof error?.code === "string" ? Number(error.code) : 0;
    const validCode = Number.isInteger(code) && code >= 400 && code <= 599;
    // Provider strings are only inspected for a known condition, never included in errors.
    const blocked = /\bSAFETY\b|content[ _-]?(policy|filter)|PROHIBITED|blocked|moderation|empty answer|refused/i.test(
      JSON.stringify(error) ?? "",
    );
    const status = !res.ok && transient(res.status) ? res.status : validCode ? code : !res.ok ? res.status : blocked ? 400 : 502;
    if (retries > 0 && transient(status) && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 1000));
      signal?.throwIfAborted();
      return post(env, route, path, body, spend, signal, prices, retries - 1);
    }
    const detail = blocked ? "blocked by provider policy" : res.ok && error == null ? "invalid response" : "request failed";
    if (!openRouter) throw new Error(`AI provider ${path} failed (HTTP ${status}): ${detail}`);
    fail(path, status, detail);
  }
  return data;
}

type ChatBody = {
  messages: ChatMessage[];
  tools?: { type: string }[];
  tool_choice?: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: object;
} & Record<string, unknown>;

/** The compatible API receives only portable options and function tools. */
function compatibleBody(body: ChatBody) {
  const { temperature, max_tokens, response_format, tools, tool_choice } = body;
  const messages = body.messages.map((m) => {
    if (m.role !== "assistant") return m;
    const { reasoning_details, ...message } = m;
    return message;
  });
  const functions = tools?.filter((tool) => tool.type === "function");
  return { temperature, max_tokens, response_format, messages, ...(functions?.length && { tools: functions, tool_choice }) };
}

export async function chat(
  env: Env,
  workload: Workload,
  body: ChatBody,
  spend: Spend,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  return routedChat(env, await requireAIRoute(env, workload), body, spend, signal);
}

/** Pin the route for a multi-turn tool conversation. */
export async function routedChat(env: Env, route: Route, body: ChatBody, spend: Spend, signal = AbortSignal.timeout(120_000)): Promise<AssistantMessage> {
  const request = route.providerId === "openrouter" ? body : compatibleBody(body);
  const data = await post(env, route, "/chat/completions", { ...request, model: route.model }, spend, signal, route);
  return data.choices[0].message;
}

export type EmbedInput = string | { content: Part[] };

export async function embed(
  env: Env,
  input: EmbedInput[],
  inputType: "search_document" | "search_query",
  spend: Spend,
): Promise<number[][]> {
  const data = await post(
    env,
    { providerId: "openrouter", baseUrl: BASE, key: await openRouterKey(env) },
    "/embeddings",
    { model: MODELS.embed, input, input_type: inputType, dimensions: EMBED_DIMS },
    spend,
  );
  return (data.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export type KeySource = "global" | "user";

export interface Batch {
  id: string;
  status: "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "expired" | "cancelled";
  usage?: Usage;
  request_counts?: { total: number; completed: number; failed: number };
  error?: { message?: string } | null;
  results?: { custom_id: string; response?: any; error?: { message?: string } | unknown }[] | null;
}

async function batchFetch(key: string, path: string, init: RequestInit = {}): Promise<Batch> {
  const res = await outboundFetch(`${BASE}/batches${path}`, {
    ...init,
    redirect: "error",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "memesave-bot" },
  });
  const data = await parse(res);
  if (!res.ok || !data) fail("batches", res.ok ? 502 : res.status);
  return data;
}

/** Submits with the instance's DB-backed OpenRouter key. `requests` goes last: OpenRouter requires it. */
export async function createBatch(key: string, head: Record<string, unknown>, requests: unknown[]) {
  return batchFetch(key, "", { method: "POST", body: JSON.stringify({ ...head, requests }) });
}

/** Reads a batch with the same key source that submitted it. */
export async function getBatch(env: Env, userId: number, source: KeySource, id: string) {
  // Legacy user-owned batches must not silently poll with shared credentials.
  const key = source === "user" ? await keyFor(env, userId, source) : await openRouterKey(env);
  if (!key) throw new Error("OpenRouter batch credentials are unavailable");
  return batchFetch(key, `/${encodeURIComponent(id)}`);
}
