import { Buffer, isUtf8 } from "node:buffer";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { buildConnector, Client, errors } from "undici/index.js";

// Leave room for base64 inline media (up to 20 MiB before encoding). Chat replies
// are text/tool arguments and should be much smaller, even on error responses.
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class AITransportError extends Error {}

/** Only ordinary global unicast addresses. Reject special-use and transition ranges. */
export function isPublicAIAddress(address: string): boolean {
  // Scope IDs have meaning only on a local network.
  if (address.includes("%")) return false;
  if (isIP(address) === 4) {
    const [a, b, c, d] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 ||
      // Azure platform virtual IP, despite being outside the standard private ranges.
      a === 168 && b === 63 && c === 129 && d === 16);
  }
  if (isIP(address) !== 6) return false;
  const [first, second] = address.split(":").map((part) => parseInt(part || "0", 16));
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

export function customAIBase(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const input = value.trim();
  // Reject ambiguous URL spellings and even empty userinfo, query or fragment delimiters.
  if (!/^https:\/\/[^/]/i.test(input) || /[\s\x00-\x1f\x7f\\@?#]/.test(input)) return null;
  try {
    const url = new URL(input);
    const host = hostOf(url);
    if (isIP(host) ? !isPublicAIAddress(host) :
      host.length > 253 || !host.includes(".") || !host.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
      /\.(localhost|local|localdomain|internal|lan|home|corp|onion)$/.test(host) || host.endsWith(".home.arpa")) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

/** Resolve once per request and hand a literal address (never the DNS name) to the TLS connector. */
type LookupAll = (hostname: string, options: { all: true }) => Promise<{ address: string }[]>;
async function pinAIHost(host: string, resolve: LookupAll): Promise<string> {
  const answers = isIP(host) ? [{ address: host }] : await resolve(`${host}.`, { all: true });
  if (!answers.length || answers.some(({ address }) => !isPublicAIAddress(address))) {
    throw new AITransportError("AI provider requires public DNS addresses");
  }
  return answers[0].address;
}

/** No proxy or redirect handling. Undici keeps the original HTTP authority; TLS verifies the original hostname. */
export async function customAIPost(base: string, body: string, key: string, signal?: AbortSignal,
  resolve: LookupAll = lookup, connect?: ReturnType<typeof buildConnector>): Promise<Response> {
  try {
    if (customAIBase(base) !== base) throw new AITransportError("Invalid AI provider destination");
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new AITransportError("AI provider request is too large");
    const target = new URL(`${base}/chat/completions`);
    const host = hostOf(target);
    signal?.throwIfAborted();
    const address = await pinAIHost(host, resolve);
    signal?.throwIfAborted();
    const dial = connect ?? buildConnector({ rejectUnauthorized: true, allowH2: false });
    const client = new Client(target.origin, {
      maxHeaderSize: 16 * 1024,
      maxResponseSize: MAX_RESPONSE_BYTES,
      connect: (options, callback) => dial({ ...options, hostname: address, servername: isIP(host) ? undefined : host }, callback),
    });
    try {
      const { statusCode, headers, body: response } = await client.request({
        method: "POST", path: target.pathname, body, signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "accept-encoding": "identity" },
      });
      // Destroying the client can error the body even if we never start reading it.
      response.on("error", () => {});
      if (statusCode >= 300 && statusCode < 400) throw new AITransportError("AI provider redirects are not allowed");
      if (statusCode === 204 || statusCode === 205) return new Response(null, { status: statusCode });
      const encoding = headers["content-encoding"];
      if (encoding !== undefined && (typeof encoding !== "string" || encoding.trim().toLowerCase() !== "identity")) {
        throw new AITransportError("AI provider returned an unsupported content encoding");
      }
      const length = Number(headers["content-length"]);
      if (length > MAX_RESPONSE_BYTES) throw new AITransportError("AI provider response is too large");
      // Bound both the parser's wire bytes and the bytes passed to Response, for
      // all statuses and even when Content-Length is absent. No decompression.
      let bytes = Buffer.alloc(0);
      let size = 0;
      for await (const chunk of response as AsyncIterable<Buffer>) {
        const nextSize = size + chunk.byteLength;
        if (nextSize > MAX_RESPONSE_BYTES) throw new AITransportError("AI provider response is too large");
        if (nextSize > bytes.length) {
          const capacity = Math.min(MAX_RESPONSE_BYTES, Math.max(nextSize, 4096, bytes.length * 2));
          const larger = Buffer.allocUnsafe(capacity);
          bytes.copy(larger, 0, 0, size);
          bytes = larger;
        }
        bytes.set(chunk, size);
        size = nextSize;
      }
      const payload = bytes.subarray(0, size);
      // Reject invalid UTF-8 so decoding cannot expand malformed bytes to replacement characters.
      if (!isUtf8(payload)) throw new AITransportError("AI provider returned an invalid text response");
      return new Response(payload, { status: statusCode });
    } finally {
      await client.destroy();
    }
  } catch (error) {
    if (signal?.aborted) {
      const aborted = new Error("AI provider request aborted");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (error instanceof AITransportError) throw error;
    if (error instanceof errors.ResponseExceededMaxSizeError) throw new Error("AI provider response is too large");
    // Do not retain causes: DNS, TLS, parser and abort errors can contain addresses,
    // raw HTTP fragments, or caller-supplied values that must not reach logs.
    throw new Error("AI provider transport failed");
  }
}
