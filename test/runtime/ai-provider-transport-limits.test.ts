import { expect, test } from "bun:test";
import { createServer, type RequestListener } from "node:http";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import type { buildConnector } from "undici/index.js";
import { customAIPost } from "../../src/aiprovidertransport";

const base = "https://private-name.example/v1";
const secret = "provider-secret-marker";
const dns = async () => [{ address: "8.8.8.8" }];
const maxReply = 1024 * 1024;

async function withProvider(handler: RequestListener, testRequest: (post: () => Promise<Response>) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const dial: ReturnType<typeof buildConnector> = (_options, callback) => {
      const socket = connect(address.port, "127.0.0.1");
      const failed = (error: Error) => callback(error, null);
      socket.once("error", failed);
      socket.once("connect", () => { socket.removeListener("error", failed); callback(null, socket); });
    };
    await testRequest(() => customAIPost(base, "{}", secret, AbortSignal.timeout(2000), dns, dial));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("custom AI transport caps UTF-8 request bytes before DNS", async () => {
  let lookups = 0;
  await expect(customAIPost(base, "é".repeat(16 * 1024 * 1024 + 1), secret, undefined,
    async () => { lookups++; return dns(); })).rejects.toThrow("AI provider request is too large");
  expect(lookups).toBe(0);
});

test("custom AI transport preserves bounded successful and error replies", async () => {
  let status = 200;
  await withProvider((req, res) => {
    req.resume();
    res.writeHead(status, { "Content-Encoding": "identity" });
    res.end("é".repeat(maxReply / 2));
  }, async (post) => {
    for (status of [200, 429]) {
      const reply = await post();
      expect(reply.status).toBe(status);
      expect((await reply.arrayBuffer()).byteLength).toBe(maxReply);
    }
  });
});

for (const status of [200, 503]) {
  test(`custom AI transport cuts off oversized chunked HTTP ${status} without waiting for EOF`, async () => {
    await withProvider((req, res) => {
      req.resume();
      res.writeHead(status);
      const chunk = Buffer.alloc(64 * 1024, "x");
      for (let i = 0; i < 17; i++) res.write(chunk);
      // Keep the stream open; the request must reject on size, not on EOF or timeout.
    }, async (post) => { await expect(post()).rejects.toThrow("AI provider response is too large"); });
  });
}

test("custom AI transport rejects oversized Content-Length from headers alone", async () => {
  await withProvider((req, res) => {
    req.resume();
    res.writeHead(429, { "Content-Length": maxReply + 1 });
    res.flushHeaders();
  }, async (post) => { await expect(post()).rejects.toThrow("AI provider response is too large"); });
});

test("custom AI transport rejects compressed replies and malformed UTF-8 instead of expanding them", async () => {
  let encoded = true;
  await withProvider((req, res) => {
    req.resume();
    if (encoded) {
      expect(req.headers["accept-encoding"]).toBe("identity");
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(maxReply + 1, "x")));
    } else {
      res.end(Buffer.alloc(maxReply, 0xff));
    }
  }, async (post) => {
    await expect(post()).rejects.toThrow("AI provider returned an unsupported content encoding");
    encoded = false;
    await expect(post()).rejects.toThrow("AI provider returned an invalid text response");
  });
});

async function expectSafeFailure(request: Promise<Response>, message = "AI provider transport failed", name = "Error") {
  const outcome = await request.catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  const error = outcome as Error;
  expect(error.message).toBe(message);
  expect(error.name).toBe(name);
  expect(error.cause).toBeUndefined();
  expect(error.stack).not.toContain(secret);
  expect(error.stack).not.toContain("private-name.example");
}

test("custom AI transport sanitizes DNS, connector and abort errors", async () => {
  const raw = new Error(`lookup/connect error ${base} ${secret}`);
  await expectSafeFailure(customAIPost(base, "{}", secret, undefined, async () => { throw raw; }));
  await expectSafeFailure(customAIPost(base, "{}", secret, undefined, dns, (_options, callback) => callback(raw, null)));
  const controller = new AbortController();
  controller.abort(raw);
  await expectSafeFailure(customAIPost(base, "{}", secret, controller.signal, dns), "AI provider request aborted", "AbortError");
});

test("custom AI transport sanitizes HTTP parser errors and mid-stream disconnects", async () => {
  let malformed = true;
  await withProvider((req, res) => {
    req.resume();
    if (malformed) req.socket.end(`Not HTTP: ${secret}\r\n\r\n`);
    else {
      res.writeHead(200, { "Content-Length": 100 });
      res.write(secret, () => req.socket.destroy());
    }
  }, async (post) => {
    await expectSafeFailure(post());
    malformed = false;
    await expectSafeFailure(post());
  });
});

test("custom AI transport bounds response headers without exposing their contents", async () => {
  await withProvider((req, res) => {
    req.resume();
    res.writeHead(500, { "X-Provider-Debug": `${secret}${"x".repeat(16 * 1024)}` });
    res.end();
  }, async (post) => { await expectSafeFailure(post()); });
});
