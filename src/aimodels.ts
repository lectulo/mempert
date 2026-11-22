import type { Env } from "./env";
import { decrypt, encrypt } from "./userkey";
import { customAIBase } from "./aiprovidertransport";
import { DESCRIBE_FALLBACKS, DESCRIBE_UNCENSORED, DESCRIBE_VIDEO_FALLBACKS } from "./config";

export const AI_WORKLOADS = [
  "photo_medium", "photo_max", "video", "search_rewrite", "search_agent",
  "analysis_labels", "pair_facts", "analysis_moods", "pair_moods",
] as const;
export type AIWorkload = (typeof AI_WORKLOADS)[number];

// These calls carry both credentials and user data. Pin the entire API base, not just HTTPS.
const destinations = { openrouter: "https://openrouter.ai/api/v1" } as const;
export const seededAIBase = (id: string): string | undefined => Object.hasOwn(destinations, id)
  ? destinations[id as keyof typeof destinations] : undefined;
const providerId = (id: unknown): id is string => typeof id === "string" && /^[a-z][a-z\d_-]{0,63}$/.test(id);

export interface AIProvider {
  providerId: string;
  baseUrl: string;
  key: string;
}
export interface AIPrices {
  prompt: number;
  completion: number;
  cacheWrite: number;
  cacheRead: number;
}
type AIModel = { providerId: string; model: string } & AIPrices;
type AdminAIModel = AIModel & { deleteProtected?: boolean };
export type ResolvedAI = AIProvider & AIPrices & { model: string };
type ProviderRow = Pick<AIProvider, "providerId" | "baseUrl"> & { sealedKey: string | null };

const providerColumns = "p.id AS providerId, p.base_url AS baseUrl, p.sealed_key AS sealedKey";
const modelColumns = "m.model, m.prompt, m.completion, m.cache_write AS cacheWrite, m.cache_read AS cacheRead";
const keySecret = (env: Env, id: string, baseUrl: string) => {
  if (!env.ENCRYPTION_KEY) throw new Error("AI provider encryption unavailable");
  const scope = seededAIBase(id) ? id : `${id}:${baseUrl}`;
  return `ai-provider:${scope}:${env.ENCRYPTION_KEY}`;
};

async function connection(env: Env, row: ProviderRow): Promise<AIProvider | null> {
  const { providerId: id, baseUrl, sealedKey } = row;
  if (!providerId(id) || (seededAIBase(id) ?? customAIBase(baseUrl)) !== baseUrl || sealedKey === null) return null;
  let key: string;
  try {
    key = await decrypt(keySecret(env, id, baseUrl), sealedKey);
  } catch {
    throw new Error("AI provider key unavailable");
  }
  return key ? { providerId: id, baseUrl, key } : null;
}

/** Internal credentials for calls that are fixed to a provider rather than a workload. */
export async function getAIProvider(env: Env, id: string): Promise<AIProvider | null> {
  if (!providerId(id)) return null;
  const row = await env.DB.prepare(`SELECT ${providerColumns} FROM ai_providers p WHERE p.id = ?`).bind(id).first<ProviderRow>();
  return row && connection(env, row);
}

/** Resolve configuration on each call so edits and key rotation take effect immediately. */
export async function resolveAI(env: Env, workload: AIWorkload): Promise<ResolvedAI | null> {
  const row = await env.DB.prepare(`SELECT ${providerColumns}, ${modelColumns}
    FROM ai_routes r JOIN ai_models m ON (r.provider_id, r.model) = (m.provider_id, m.model)
    JOIN ai_providers p ON p.id = m.provider_id WHERE r.workload = ?`).bind(workload).first<ProviderRow & AIModel>();
  if (!row) return null;
  const provider = await connection(env, row);
  const { model, prompt, completion, cacheWrite, cacheRead } = row;
  return provider && { ...provider, model, prompt, completion, cacheWrite, cacheRead };
}

type RouteRow = { workload: AIWorkload; providerId: string; model: string };
const routeQuery = (env: Env) => env.DB.prepare("SELECT workload, provider_id AS providerId, model FROM ai_routes ORDER BY workload");
const routesByWorkload = (rows: RouteRow[]) => Object.fromEntries(rows.map(({ workload, ...route }) => [workload, route]));

export async function listAIRoutes(env: Env) {
  return routesByWorkload((await routeQuery(env).all<RouteRow>()).results);
}

const KEY_MASK = "••••";
const fallbackModels = new Set([...DESCRIBE_FALLBACKS, ...DESCRIBE_VIDEO_FALLBACKS, DESCRIBE_UNCENSORED]);
const isProtectedModel = (id: string, model: string) => id === "openrouter" && fallbackModels.has(model);

async function previewKey(env: Env, row: ProviderRow): Promise<string | null> {
  if (row.sealedKey === null) return null;
  try {
    const key = (await connection(env, row))?.key;
    if (key && key.length > 4 && /^[!-~]+$/.test(key)) return `${key.slice(0, 2)}${KEY_MASK}${key.slice(-2)}`;
  } catch {
    // Old or unreadable credentials are still stored; never echo the ciphertext or decryption error.
  }
  return KEY_MASK;
}

/** Interactive admin view. Only the masked preview leaves the server. */
export async function listAIConfig(env: Env) {
  const [providers, models, routes] = await env.DB.batch([
    env.DB.prepare(`SELECT ${providerColumns}, p.name FROM ai_providers p ORDER BY p.id`),
    env.DB.prepare(`SELECT m.provider_id AS providerId, ${modelColumns} FROM ai_models m ORDER BY m.provider_id, m.model`),
    routeQuery(env),
  ]);
  return {
    providers: await Promise.all((providers.results as (ProviderRow & { name: string })[]).map(async (row) => ({
      id: row.providerId, name: row.name, baseUrl: row.baseUrl, hasKey: row.sealedKey !== null, keyPreview: await previewKey(env, row),
    }))),
    models: (models.results as AIModel[]).map((row): AdminAIModel =>
      isProtectedModel(row.providerId, row.model) ? { ...row, deleteProtected: true } : row),
    routes: routesByWorkload(routes.results as RouteRow[]),
  };
}

const isPrice = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const isModel = (model: unknown): model is string => typeof model === "string" && /^[a-z\d][a-z\d._:/@-]{0,199}$/i.test(model);
export const OPENROUTER_BATCH_KEY_IN_USE = "Wait for active OpenRouter batches to finish before changing the shared key.";
const OPENROUTER_PROVIDER_REQUIRED = "OpenRouter cannot be deleted because it is required for embeddings and batches.";
const OPENROUTER_FALLBACK_REQUIRED = "This OpenRouter model cannot be deleted because it is a built-in description fallback.";
const PROVIDER_IN_USE = "Reassign active workload routes before deleting this provider.";
const MODEL_IN_USE = "Reassign active workload routes before deleting this model.";
export const isAIConfigConflict = (error: string) =>
  [OPENROUTER_BATCH_KEY_IN_USE, OPENROUTER_PROVIDER_REQUIRED, OPENROUTER_FALLBACK_REQUIRED, PROVIDER_IN_USE, MODEL_IN_USE].includes(error);

/** Validated configuration writes. Returns a static error message on rejection, or null on success. */
export async function saveAIConfig(env: Env, body: unknown): Promise<string | null> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "bad body";
  const data = body as Record<string, unknown>;
  if (data.action === "provider" || data.action === "provider_create") {
    const { id, name, baseUrl, key } = data;
    if (!providerId(id)) return "bad provider id";
    if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) return "bad provider name";
    if (seededAIBase(id) && data.action === "provider_create") return "provider id already exists";
    if (key !== undefined && key !== null && (typeof key !== "string" || key.length > 4096 || /[^!-~]/.test(key))) return "bad provider key";
    if (data.action === "provider_create") {
      const destination = customAIBase(baseUrl);
      if (!destination) return "provider requires a public HTTPS API base";
      if (typeof key !== "string" || !key) return "provider requires a key";
      const sealed = await encrypt(keySecret(env, id, destination), key);
      const { meta } = await env.DB.prepare(`INSERT INTO ai_providers (id, name, base_url, sealed_key) VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING`).bind(id, name.trim(), destination, sealed).run();
      return meta.changes ? null : "provider id already exists";
    }
    const row = await env.DB.prepare("SELECT base_url FROM ai_providers WHERE id = ?").bind(id).first<string>("base_url");
    if (!row) return "unknown provider";
    const destination = seededAIBase(id) ?? customAIBase(row);
    if (destination !== row || (baseUrl !== undefined && customAIBase(baseUrl) !== row)) return "provider destination is fixed";
    // Blank or omitted leaves the key unchanged; null removes the stored key.
    if (key === undefined || key === "") {
      await env.DB.prepare("UPDATE ai_providers SET name = ? WHERE id = ?").bind(name.trim(), id).run();
    } else {
      const sealed = key === null ? null : await encrypt(keySecret(env, id, row), key);
      try {
        await env.DB.prepare("UPDATE ai_providers SET name = ?, sealed_key = ? WHERE id = ?")
          .bind(name.trim(), sealed, id).run();
      } catch (error) {
        if (id === "openrouter" && error instanceof Error && error.message === "openrouter_batch_key_in_use") {
          return OPENROUTER_BATCH_KEY_IN_USE;
        }
        throw error;
      }
    }
    return null;
  }
  if (Object.hasOwn(data, "key")) return "key is only accepted for provider writes";
  if (data.action === "deleteProvider") {
    const { id } = data;
    if (!providerId(id)) return "bad provider id";
    if (id === "openrouter") return OPENROUTER_PROVIDER_REQUIRED;

    // D1 batches are transactional. Conditional deletes keep all rows intact for a routed
    // provider; the foreign keys also forbid deleting any referenced model or provider.
    const activeRoute = "SELECT 1 FROM ai_routes WHERE provider_id = ?";
    const [active, , deleted] = await env.DB.batch([
      env.DB.prepare(`${activeRoute} LIMIT 1`).bind(id),
      env.DB.prepare(`DELETE FROM ai_models WHERE provider_id = ? AND NOT EXISTS (${activeRoute})`).bind(id, id),
      env.DB.prepare(`DELETE FROM ai_providers WHERE id = ? AND NOT EXISTS (${activeRoute})`).bind(id, id),
    ]);
    if (active.results.length) return PROVIDER_IN_USE;
    return deleted.meta.changes ? null : "unknown provider";
  }
  if (data.action === "deleteModel") {
    const { providerId: id, model } = data;
    if (!providerId(id)) return "bad provider id";
    if (!isModel(model)) return "bad model";
    if (isProtectedModel(id, model)) return OPENROUTER_FALLBACK_REQUIRED;
    const activeRoute = "SELECT 1 FROM ai_routes WHERE provider_id = ? AND model = ?";
    const [active, deleted] = await env.DB.batch([
      env.DB.prepare(`${activeRoute} LIMIT 1`).bind(id, model),
      env.DB.prepare(`DELETE FROM ai_models WHERE provider_id = ? AND model = ? AND NOT EXISTS (${activeRoute})`).bind(id, model, id, model),
    ]);
    if (active.results.length) return MODEL_IN_USE;
    return deleted.meta.changes ? null : "unknown model for provider";
  }
  if (data.action === "model" || data.action === "route") {
    const { providerId: id, model } = data;
    if (!providerId(id) || !await env.DB.prepare("SELECT 1 FROM ai_providers WHERE id = ?").bind(id).first()) return "unknown provider";
    if (!isModel(model)) return "bad model";
    if (data.action === "model") {
      const { prompt, completion, cacheWrite, cacheRead } = data;
      if (!isPrice(prompt) || !isPrice(completion) || !isPrice(cacheWrite) || !isPrice(cacheRead)) return "bad prices";
      await env.DB.prepare(`INSERT INTO ai_models (provider_id, model, prompt, completion, cache_write, cache_read)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider_id, model) DO UPDATE SET
        prompt = excluded.prompt, completion = excluded.completion, cache_write = excluded.cache_write, cache_read = excluded.cache_read`)
        .bind(id, model, prompt, completion, cacheWrite, cacheRead).run();
      return null;
    }
    const { workload } = data;
    if (!AI_WORKLOADS.includes(workload as AIWorkload)) return "unknown workload";
    const { meta } = await env.DB.prepare(`INSERT INTO ai_routes (workload, provider_id, model)
      SELECT ?, provider_id, model FROM ai_models WHERE provider_id = ? AND model = ?
      ON CONFLICT (workload) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`)
      .bind(workload, id, model).run();
    return meta.changes ? null : "unknown model for provider";
  }
  return "bad action";
}
