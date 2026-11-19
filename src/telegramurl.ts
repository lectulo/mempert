import type { Env } from "./env";

/** Telegram rejects WebApp buttons without HTTPS, including local-only origins. */
export function publicWebAppUrl(env: Pick<Env, "PUBLIC_URL">): string | undefined {
  const url = new URL(env.PUBLIC_URL);
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) || url.hostname.endsWith(".localhost")) return;
  return `${url.origin}/`;
}
