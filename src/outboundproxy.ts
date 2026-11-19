import type { Api } from "grammy";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
// Explicit JS entrypoint bypasses Bun's built-in undici compatibility shim.
import { Client, ProxyAgent, Socks5ProxyAgent, fetch as proxyFetch, type Dispatcher } from "undici/index.js";

const invalidProxy = () => new Error("OUTBOUND_PROXY_URL must be an HTTP, HTTPS or SOCKS5 proxy URL");

/** Empty disables the proxy. Validation errors never include the supplied URL. */
export function validateOutboundProxyUrl(value: string | undefined): string {
  if (!value?.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname ||
      url.pathname && url.pathname !== "/" || url.search || url.hash) throw invalidProxy();
    decodeURIComponent(url.username); decodeURIComponent(url.password);
    if (url.protocol === "socks5:") url.protocol = "socks5h:";
    return url.href;
  } catch { throw invalidProxy(); }
}

function configuredProxy() {
  return typeof process === "undefined" ? undefined : process.env.OUTBOUND_PROXY_URL;
}

let cached: { url: string; dispatcher: Dispatcher } | undefined;
function proxyDispatcher(url: string): Dispatcher {
  if (cached?.url === url) return cached.dispatcher;
  void cached?.dispatcher.close().catch(() => {});
  const endpoint = new URL(url);
  const userId = decodeURIComponent(endpoint.username), password = decodeURIComponent(endpoint.password);
  endpoint.username = ""; endpoint.password = "";
  const socks = endpoint.protocol.startsWith("socks");
  if (socks) endpoint.protocol = "socks5:";
  const dispatcher = socks ? new Socks5ProxyAgent(endpoint, { username: userId, password }) : new ProxyAgent({
    uri: endpoint.href,
    // Undici passes an IP as SNI for IP-literal HTTPS proxies; Bun correctly
    // rejects that. Omit SNI while retaining default certificate/IP validation.
    ...(endpoint.protocol === "https:" && isIP(endpoint.hostname) ? {
      clientFactory(origin, options) {
        return new Client(origin, { ...options, connect(connectOptions, callback) {
          const socket = tlsConnect({ host: connectOptions.hostname, port: Number(connectOptions.port) || 443, ALPNProtocols: ["http/1.1"] });
          const failed = (error: Error) => callback(error, null);
          socket.once("error", failed);
          socket.once("secureConnect", () => { socket.removeListener("error", failed); callback(null, socket); });
        } });
      },
    } : {}),
    ...(userId || password ? { token: `Basic ${Buffer.from(`${userId}:${password}`).toString("base64")}` } : {}),
  });
  cached = { url, dispatcher };
  return dispatcher;
}

function transportError(aborted: boolean) {
  const error = new Error(aborted ? "Outbound request aborted" : "Outbound transport failed");
  if (aborted) error.name = "AbortError";
  return error;
}

/** Streaming transport for Telegram/OpenRouter only. Explicit "" forces direct. */
export async function outboundFetch(input: string | URL | Request, init?: RequestInit, proxyUrl?: string): Promise<Response> {
  const proxy = validateOutboundProxyUrl(proxyUrl ?? configuredProxy());
  if (!proxy) return fetch(input, init);
  let signal = init?.signal;
  try {
    const options = { ...init, duplex: "half" } as RequestInit;
    const request = typeof input === "string" || input instanceof URL ? new Request(String(input), options) : new Request(input, options);
    const target = new URL(request.url);
    if (target.protocol !== "https:" || !["api.telegram.org", "oauth.telegram.org", "openrouter.ai"].includes(target.hostname) ||
      target.username || target.password || target.port && target.port !== "443") throw transportError(false);
    signal = request.signal;
    const response = await proxyFetch(request.url, {
      method: request.method, headers: [...request.headers.entries()], body: request.body,
      signal: request.signal, redirect: "manual", dispatcher: proxyDispatcher(proxy), duplex: "half",
    });
    // ProxyAgent rejects CONNECT errors rather than returning proxy response bodies.
    // Do not forward API credentials or payloads through redirects either.
    if ([301, 302, 303, 307, 308].includes(response.status) && request.redirect !== "manual") {
      await response.body?.cancel();
      throw transportError(false);
    }
    const noBody = request.method === "HEAD" || [204, 205, 304].includes(response.status);
    if (noBody) await response.body?.cancel();
    const reader = !noBody ? response.body?.getReader() : undefined;
    const body = reader ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close(); else controller.enqueue(value);
        } catch { controller.error(transportError(!!signal?.aborted)); }
      },
      cancel() { return reader.cancel().catch(() => {}); },
    }) : null;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()] });
  } catch { throw transportError(!!signal?.aborted); }
}

/** new Api(token, options), or new Bot(token, { client: options }). */
export function telegramClientOptions(proxyUrl?: string): NonNullable<ConstructorParameters<typeof Api>[1]> {
  const proxy = validateOutboundProxyUrl(proxyUrl ?? configuredProxy());
  if (!proxy) return {};
  const request = (input: string | URL | Request, init?: RequestInit) => outboundFetch(input, init, proxy);
  return { fetch: request as unknown as NonNullable<ConstructorParameters<typeof Api>[1]>["fetch"] };
}
