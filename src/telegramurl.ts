import type { Env } from "./env";

/** Telegram rejects WebApp buttons without HTTPS, including local-only origins. */
export function publicWebAppUrl(env: Pick<Env, "PUBLIC_URL">): string | undefined {
  const url = new URL(env.PUBLIC_URL);
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) || url.hostname.endsWith(".localhost")) return;
  return `${url.origin}/`;
}

/** The HTTPS origin Telegram can use to fetch signed media, not necessarily the Web App origin. */
export function telegramMediaOrigin(env: Pick<Env, "MEDIA_URL" | "PUBLIC_URL">): string | null {
  const input = env.MEDIA_URL?.trim() || env.PUBLIC_URL.trim();
  // Check the raw spelling before URL parsing can erase dot segments or empty delimiters.
  if (!/^https:\/\/[^/\s\x00-\x1f\x7f\\@?#]+\/?$/i.test(input)) return null;
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/\.$/, "");
    // Check the canonical hostname: URL normalizes short, numeric and hex IPv4 aliases.
    if (host.startsWith("[")) {
      // Only IPv6 global unicast; excludes loopback, ULA, link-local and IPv4-mapped addresses.
      if (!/^\[[23]/.test(host) || /^\[(?:2001:db8|2002|3fff):/.test(host)) return null;
    } else if (/^\d+(?:\.\d+){3}$/.test(host)) {
      const [a, b, c] = host.split(".").map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
          a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2)) ||
          a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return null;
    } else if (!host.includes(".") || /\.(localhost|local|localdomain|internal|lan|home|corp|onion)$/.test(host) || host.endsWith(".home.arpa") || host === "home.arpa" ||
        !host.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) return null;
    return url.origin;
  } catch { return null; }
}
