// Bun loads the project's .env automatically; Compose supplies the same values through env_file.
// Preview: bun scripts/setup.ts --dry-run
// Apply (TELEGRAM_MODE=webhook only): docker compose exec app bun scripts/setup.ts
// Telegram Login's allowed URL and client secret still need configuration in BotFather.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const allowedUpdates = ["message", "inline_query", "chosen_inline_result", "callback_query", "pre_checkout_query", "subscription", "my_chat_member", "widget_query"];

export function webhookConfig(env: NodeJS.ProcessEnv, args: string[]) {
  if (args.some((arg) => !["--dry-run", "--drop-pending-updates"].includes(arg))) {
    throw new Error("Usage: bun scripts/setup.ts [--dry-run] [--drop-pending-updates]");
  }
  const token = env.BOT_TOKEN;
  const secret = env.WEBHOOK_SECRET;
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Set a valid BOT_TOKEN.");
  if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("Set WEBHOOK_SECRET (1–256 letters, digits, underscores or hyphens).");
  }
  // Retain compatibility with existing invocations; PUBLIC_URL is the server setting.
  const base = env.PUBLIC_URL || env.WORKER_URL;
  let url: URL;
  try {
    url = new URL(base ?? "");
  } catch {
    throw new Error("Set PUBLIC_URL to the public HTTPS origin of the server.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) {
    throw new Error("PUBLIC_URL must be an HTTPS origin without credentials, path, query or fragment.");
  }
  if (url.port && !["443", "80", "88", "8443"].includes(url.port)) {
    throw new Error("Telegram webhooks support ports 443, 80, 88 and 8443 only.");
  }
  return {
    token,
    dryRun: args.includes("--dry-run"),
    payload: {
      url: `${url.origin}/webhook`,
      secret_token: secret,
      allowed_updates: allowedUpdates,
      drop_pending_updates: args.includes("--drop-pending-updates"),
    },
    loginCallback: `${url.origin}/auth/telegram/callback`,
  };
}

export async function setup(env: NodeJS.ProcessEnv, args: string[], request?: typeof fetch, log: (message: string) => void = console.log) {
  const mode = env.TELEGRAM_MODE || "polling";
  if (mode !== "polling" && mode !== "webhook") throw new Error("TELEGRAM_MODE must be polling or webhook.");
  if (mode === "polling") {
    if (args.includes("--drop-pending-updates")) throw new Error("--drop-pending-updates is not allowed in polling mode; pending updates are preserved.");
    if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: bun scripts/setup.ts [--dry-run] [--drop-pending-updates]");
    if (!env.BOT_TOKEN || !/^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN)) throw new Error("Set a valid BOT_TOKEN.");
    let url: URL;
    try {
      url = new URL(env.PUBLIC_URL ?? "");
    } catch {
      throw new Error("Set PUBLIC_URL to the server origin (http://localhost:3000 is allowed for polling).");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) {
      throw new Error("PUBLIC_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
    }
    if (args.includes("--dry-run")) log("Dry run: Telegram polling configuration is valid. No requests sent.");
    log("Polling managed by app; webhook setup not required. On startup the app removes the webhook without dropping pending updates, synchronizes commands and starts long polling.");
    log("Website Telegram login still requires a public HTTPS origin and TG_CLIENT_SECRET; OpenRouter must be able to fetch signed media at PUBLIC_URL.");
    return;
  }
  const config = webhookConfig(env, args);
  // Do not log raw API responses or fetch exceptions: they can contain the token-bearing request URL.
  if (config.dryRun) {
    log(`Dry run: Telegram webhook configuration is valid; pending updates will ${config.payload.drop_pending_updates ? "be dropped" : "be preserved"}. No requests sent.`);
  } else {
    let response: Response;
    try {
      // Share the app's outbound transport (OUTBOUND_PROXY_URL from process.env).
      // Do not even initialize it for polling info or --dry-run; tests can inject a request.
      const send = request ?? (await import("../src/outboundproxy")).outboundFetch;
      response = await send(`https://api.telegram.org/bot${config.token}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config.payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Telegram webhook request failed (network error or timeout).");
    }
    const result = await response.json().catch(() => null) as { ok?: boolean } | null;
    if (!response.ok || result?.ok !== true) throw new Error(`Telegram rejected webhook configuration (HTTP ${response.status}); check the bot credentials and public HTTPS endpoint.`);
    log("Telegram webhook configured successfully.");
  }
  log(`BotFather: configure Telegram Login for your PUBLIC_URL; the login callback is ${config.loginCallback}. Set TG_CLIENT_SECRET in the server environment. Enable inline mode with /setinline if required.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setup(process.env, process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Telegram setup failed.");
    process.exitCode = 1;
  });
}
