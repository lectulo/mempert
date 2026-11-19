// Executed only in a --no-env-file child with a private test CA trust store.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { connect as tlsConnect } from "node:tls";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { Bot, InputFile } from "grammy";
import { SocksClient } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";

const [scenario, directory] = process.argv.slice(2);
// Controls intentionally do not import production, so they independently
// establish fixture correctness even if the runtime transport cannot load.
const transport = scenario.endsWith("-control") ? undefined : await import("../../src/outboundproxy");
const telegramFetch = (...args: Parameters<NonNullable<typeof transport>["outboundFetch"]>) => transport!.outboundFetch(...args);
const outboundFetch = telegramFetch;
const telegramClientOptions = () => transport!.telegramClientOptions();
const loopback = Bun.spawnSync(["ip", "link", "set", "lo", "up"], { env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
assert.equal(loopback.exitCode, 0, "isolated network namespace must support loopback");
const routes = Bun.spawnSync(["ip", "route", "show"], { env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
assert.equal(routes.exitCode, 0);
assert.equal(routes.stdout.toString().trim(), "", "fixture must have no external routes");
const tls = { key: readFileSync(`${directory}/key.pem`), cert: readFileSync(`${directory}/cert.pem`) };
const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
const streamPath = "/api/v1/fixture/binary-stream";
const abortStreamPath = "/api/v1/fixture/abort-stream";
const streamBytes = Buffer.alloc(512 * 1024);
// Deterministic high-entropy data keeps the gzip variant large on the wire too.
let word = 0x12345678;
for (let offset = 0; offset < streamBytes.length; offset += 4) {
  word ^= word << 13;
  word ^= word >>> 17;
  word ^= word << 5;
  streamBytes.writeUInt32LE(word >>> 0, offset);
}
let sendStreamTail: (() => void) | undefined;
let abortedStreamClosed: Promise<void[]> | undefined;
const username = "user@name", password = "p:a/ss%word";
const authorities: string[] = [], authentications: string[] = [];
const requests: { path: string; body: Buffer; headers: http.IncomingHttpHeaders }[] = [];
const sockets = new Set<net.Socket>();
const servers: net.Server[] = [];
const originConnections = new Map<number, net.Socket>();
const tunnels = new Map<number, { client: net.Socket; upstream: net.Socket }>();
const trace: string[] = [];
let phase = "setup";
const watchdog = setTimeout(() => { console.error(`Fixture stalled during ${phase}; CONNECT/SOCKS targets: ${authorities.join(", ")}; events: ${trace.join(", ")}`); process.exit(1); }, 10_000);
let announcePolling: () => void;
const pollingReceived = new Promise<void>(resolve => { announcePolling = resolve; });
let announceClosed: () => void;
const pollingClosed = new Promise<void>(resolve => { announceClosed = resolve; });

// CONNECT is a tunnel, not a reusable half-open application stream. Forward
// EOF in either direction and tear down the peer even when HTTP's upgraded
// sockets default to allowHalfOpen.
function pipeTunnel(client: net.Socket, upstream: net.Socket) {
  tunnels.set(upstream.localPort!, { client, upstream });
  client.pipe(upstream).pipe(client);
  client.on("end", () => upstream.end());
  upstream.on("end", () => client.end());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}

async function listen(server: net.Server) {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

const origin = https.createServer(tls, async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requests.push({ path: req.url!, body: Buffer.concat(chunks), headers: req.headers });
  if (req.url?.endsWith("getUpdates")) {
    req.socket.on("end", () => trace.push("poll-origin:end"));
    res.on("close", () => trace.push("poll-response:close"));
    req.socket.on("close", () => announceClosed());
    res.on("close", () => announceClosed());
    const raw = originConnections.get(req.socket.remotePort!);
    assert(raw, "polling request must map to an accepted TCP connection");
    raw.on("close", () => { trace.push("poll-origin-tcp:close"); announceClosed(); });
    const tunnel = tunnels.get(req.socket.remotePort!);
    assert(tunnel, "polling request must map to its actual proxy tunnel");
    // Bun's HTTPS server does not reliably emit close on IncomingMessage's
    // socket (even after a raw TLS client destroy). Observe both real proxy
    // TCP peers instead: neither side of this specific poll may remain open.
    void Promise.all([once(tunnel.client, "close"), once(tunnel.upstream, "close")]).then(() => announceClosed());
    announcePolling();
    return; // A real long poll: remain open until the caller cancels it.
  }
  if (req.url?.endsWith("getMe")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "fixture", username: "fixture_bot" } }));
    return;
  }
  if (req.url?.endsWith("sendPhoto")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, photo: [] } }));
    return;
  }
  if (req.url === streamPath) {
    const gzip = req.headers["accept-encoding"] === "gzip";
    const wire = gzip ? gzipSync(streamBytes) : streamBytes;
    const split = Math.floor(wire.length / 2);
    sendStreamTail = () => {
      sendStreamTail = undefined;
      res.end(wire.subarray(split));
    };
    res.writeHead(200, { "content-type": "application/octet-stream", ...(gzip ? { "content-encoding": "gzip" } : {}) });
    res.write(wire.subarray(0, split));
    return;
  }
  if (req.url === abortStreamPath) {
    const tunnel = tunnels.get(req.socket.remotePort!);
    assert(tunnel, "OpenRouter stream must map to its actual proxy tunnel");
    abortedStreamClosed = Promise.all([tunnel.client, tunnel.upstream].map(socket =>
      new Promise<void>(resolve => { socket.once("close", () => resolve()); })));
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(bytes);
    return; // Never finish; only client cancellation can close this response.
  }
  res.writeHead(200, { "content-type": "application/octet-stream", "x-fixture": "telegram" });
  res.write(bytes.subarray(0, 3));
  res.end(bytes.subarray(3));
});
origin.on("connection", socket => {
  originConnections.set(socket.remotePort!, socket);
  socket.on("close", () => originConnections.delete(socket.remotePort!));
});

// Read the SOCKS protocol from the wire, rather than mocking an agent or fetch.
function reader(socket: net.Socket) {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  const data = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); wake?.(); };
  socket.on("data", data);
  return {
    async take(size: number): Promise<Buffer> {
      while (buffer.length < size) await new Promise<void>(resolve => { wake = resolve; });
      const result = buffer.subarray(0, size); buffer = buffer.subarray(size); return result;
    },
    detach() { socket.off("data", data); assert.equal(buffer.length, 0); },
  };
}

try {
  const port = await listen(origin);
  const authenticated = scenario.includes("-auth");
  if (scenario.startsWith("direct-")) {
    if (scenario === "direct-unset") delete process.env.OUTBOUND_PROXY_URL;
    else process.env.OUTBOUND_PROXY_URL = "   ";
    const response = await telegramFetch(`https://127.0.0.1:${port}/direct`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(requests.length, 1);
  } else if (scenario === "invalid") {
    for (const proxy of ["ftp://user%40name:p%3Aa%2Fss%25word@127.0.0.1:1", "not a proxy"]) {
      process.env.OUTBOUND_PROXY_URL = proxy;
      await assert.rejects(async () => { await telegramFetch("https://api.telegram.org/bot1:fake/getMe"); }, error => {
        const message = String(error);
        assert(!message.includes(password)); assert(!message.includes("p%3Aa%2Fss%25word")); assert(!message.includes(proxy));
        return true;
      });
    }
    assert.equal(requests.length, 0);
  } else {
    const socks = scenario.startsWith("socks5");
    const secure = scenario.startsWith("https");
    const rejected = scenario === "rejected-auth";
    let proxy: net.Server;
    if (socks) {
      proxy = net.createServer(socket => {
        void (async () => {
          phase = "SOCKS greeting";
          const input = reader(socket);
          const greeting = await input.take(2); assert.equal(greeting[0], 5);
          const methods = await input.take(greeting[1]);
          trace.push(`socks:greeting:${greeting.toString("hex")}:${methods.toString("hex")}`);
          assert(methods.includes(authenticated ? 2 : 0));
          socket.write(Buffer.from([5, authenticated ? 2 : 0]));
          if (authenticated) {
            phase = "SOCKS authentication";
            const header = await input.take(2); assert.equal(header[0], 1);
            const user = (await input.take(header[1])).toString();
            const size = (await input.take(1))[0];
            const pass = (await input.take(size)).toString();
            authentications.push(`${user}:${pass}`);
            assert.equal(user, username); assert.equal(pass, password);
            trace.push("socks:auth-valid");
            socket.write(Buffer.from([1, 0]));
          }
          phase = "SOCKS CONNECT request";
          const request = await input.take(4);
          assert.deepEqual([...request], [5, 1, 0, 3]); // Domain, not local DNS resolution.
          const host = (await input.take((await input.take(1))[0])).toString();
          const targetPort = (await input.take(2)).readUInt16BE();
          authorities.push(`${host}:${targetPort}`);
          assert(["api.telegram.org", "openrouter.ai"].includes(host)); assert.equal(targetPort, 443);
          input.detach();
          phase = "SOCKS tunnel established";
          const upstream = net.connect(port, "127.0.0.1");
          upstream.on("error", () => socket.destroy());
          await once(upstream, "connect");
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]));
          pipeTunnel(socket, upstream);
        })().catch(error => { console.error(error); socket.destroy(); process.exitCode = 1; });
      });
    } else {
      const connectProxy = secure ? https.createServer(tls) : http.createServer();
      connectProxy.on("connect", (req, socket, head) => {
        authorities.push(req.url!);
        assert(["api.telegram.org:443", "openrouter.ai:443"].includes(req.url!));
        assert.equal(req.headers.authorization, undefined);
        authentications.push(String(req.headers["proxy-authorization"] ?? ""));
        if (rejected) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
        assert.equal(head.length, 0);
        const upstream = net.connect(port, "127.0.0.1");
        const id = authorities.length;
        for (const event of ["end", "close", "finish"] as const) {
          socket.on(event, () => trace.push(`proxy${id}-client:${event}`));
          upstream.on(event, () => trace.push(`proxy${id}-origin:${event}`));
        }
        upstream.on("error", () => socket.destroy());
        upstream.on("connect", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipeTunnel(socket as net.Socket, upstream);
        });
      });
      proxy = connectProxy;
    }
    const proxyPort = await listen(proxy);
    const credentials = authenticated || rejected ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
    process.env.OUTBOUND_PROXY_URL = `${socks ? "socks5" : secure ? "https" : "http"}://${credentials}127.0.0.1:${proxyPort}`;

    if (scenario === "http-control") {
      phase = "independent CONNECT and polling socket close";
      const raw = net.connect(proxyPort, "127.0.0.1");
      await once(raw, "connect");
      raw.write("CONNECT api.telegram.org:443 HTTP/1.1\r\nHost: api.telegram.org:443\r\n\r\n");
      const [response] = await once(raw, "data");
      assert.equal(response.toString(), "HTTP/1.1 200 Connection Established\r\n\r\n");
      const client = tlsConnect({ socket: raw, servername: "api.telegram.org" });
      await once(client, "secureConnect");
      assert(client.authorized);
      phase = "control polling request received";
      client.write("GET /bot1:fake/getUpdates HTTP/1.1\r\nHost: api.telegram.org\r\n\r\n");
      await pollingReceived;
      phase = "control polling origin socket closes";
      client.destroy();
      await pollingClosed;
    } else if (scenario.endsWith("-control")) {
      phase = "independent SocksClient.createConnection";
      const connection = await SocksClient.createConnection({
        command: "connect", proxy: { host: "127.0.0.1", port: proxyPort, type: 5,
          ...(authenticated ? { userId: username, password } : {}) },
        destination: { host: "api.telegram.org", port: 443 }, timeout: 2000,
      });
      connection.socket.destroy();
      assert(authorities.includes("api.telegram.org:443"));
      const agent = new SocksProxyAgent(process.env.OUTBOUND_PROXY_URL!.replace("socks5:", "socks5h:"));
      phase = "independent SocksProxyAgent.connect TLS";
      const tunnel = await agent.connect({ destroy() {} } as any, { host: "api.telegram.org", port: 443, secureEndpoint: true } as any);
      tunnel.write("GET /direct-agent-control HTTP/1.1\r\nHost: api.telegram.org\r\nConnection: close\r\n\r\n");
      const chunks: Buffer[] = [];
      for await (const chunk of tunnel) chunks.push(Buffer.from(chunk));
      assert.match(Buffer.concat(chunks).toString("latin1"), /^HTTP\/1\.1 200/);
      assert(requests.some(request => request.path === "/direct-agent-control"));
      agent.destroy();
    } else if (rejected) {
      try {
        const response = await telegramFetch("https://api.telegram.org/bot1:fake/getMe");
        assert.equal(response.status, 407);
        const text = await response.text();
        assert(!text.includes(password)); assert(!text.includes(encodeURIComponent(password)));
      } catch (error) {
        if ((error as Error).name === "AssertionError") throw error;
        const message = String(error);
        assert(!message.includes(password)); assert(!message.includes(encodeURIComponent(password))); assert(!message.includes(process.env.OUTBOUND_PROXY_URL!));
      }
      assert.equal(authorities.length, 1);
      assert.equal(requests.length, 0);
    } else {
      const response = await telegramFetch("https://api.telegram.org/file/bot1:fake/binary", {
        method: "POST", body: bytes, headers: { "x-request-fixture": "sent" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-fixture"), "telegram");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.deepEqual(requests[0].body, bytes);
      assert.equal(requests[0].headers["x-request-fixture"], "sent");
      assert.equal(requests[0].headers["proxy-authorization"], undefined);
      const bot = new Bot("1:fake", { client: { ...telegramClientOptions(), timeoutSeconds: 0.15 } });
      assert.equal((await bot.api.getMe()).username, "fixture_bot");
      await bot.api.sendPhoto(1, new InputFile(bytes, "fixture.bin"));
      const upload = requests.find(request => request.path.endsWith("sendPhoto"))!;
      assert.match(String(upload.headers["content-type"]), /^multipart\/form-data;.*boundary=/);
      assert(upload.body.includes(bytes));
      assert.match(upload.body.toString("latin1"), /filename=(?:"fixture\.bin"|fixture\.bin)(?:\r\n|;)/);
      assert.equal(upload.headers["proxy-authorization"], undefined);
      for (const path of ["/api/v1/chat/completions", "/api/v1/auth/keys"]) {
        const body = JSON.stringify(path.endsWith("keys") ? { code: "synthetic-code", code_verifier: "synthetic-verifier" } : { model: "fixture", messages: [{ role: "user", content: "offline" }] });
        const response = await outboundFetch(`https://openrouter.ai${path}`, {
          method: "POST", headers: { Authorization: "Bearer synthetic-test-only", "Content-Type": "application/json" }, body,
        });
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        const received = requests.at(-1)!;
        assert.equal(received.path, path);
        assert.equal(received.body.toString(), body);
        assert.equal(received.headers.authorization, "Bearer synthetic-test-only");
        assert.equal(received.headers["proxy-authorization"], undefined);
      }
      if (authenticated) {
        const expected = socks ? `${username}:${password}` : `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
        assert(authentications.length > 0);
        assert(authentications.every(value => value === expected));
      } else assert(authentications.every(value => value === ""));
      // Check isolation before cancellation: dispatchers may asynchronously
      // replace a canceled pooled connection, unrelated to native fetch.
      const count = authorities.length;
      const other = await fetch(`https://127.0.0.1:${port}/unrelated`);
      assert.deepEqual(Buffer.from(await other.arrayBuffer()), bytes);
      assert.equal(authorities.length, count);
      const controller = new AbortController();
      phase = "waiting for long polling request";
      const pending = telegramFetch("https://api.telegram.org/bot1:fake/getUpdates", { signal: controller.signal });
      await pollingReceived;
      phase = "aborting fetch";
      controller.abort();
      await assert.rejects(pending, error => (error as Error).name === "AbortError");
      phase = "waiting for aborted polling socket to close";
      await pollingClosed;
      phase = "grammY timeout";
      await assert.rejects(bot.api.getUpdates({ timeout: 30 }), error => {
        // grammY intentionally hides transport details in HttpError.message;
        // its original timeout is available in the documented error property.
        assert.match(String((error as { error?: unknown }).error), /getUpdates.*timed out after 0\.15 seconds/i);
        return true;
      });
      for (const encoding of ["identity", "gzip"]) {
        phase = `OpenRouter ${encoding} stream headers`;
        const response = await outboundFetch(`https://openrouter.ai${streamPath}`, { headers: { "accept-encoding": encoding } });
        assert.equal(response.status, 200);
        assert.equal(requests.at(-1)?.headers["accept-encoding"], encoding);
        assert(response.body);
        const reader = response.body.getReader();
        phase = `OpenRouter ${encoding} first body bytes before origin sends the tail`;
        const first = await reader.read();
        assert(!first.done && first.value.byteLength > 0);
        const chunks = [Buffer.from(first.value)];
        // The first read, not a timer, lets the origin send its second part.
        assert(sendStreamTail);
        sendStreamTail();
        phase = `OpenRouter ${encoding} remaining body through EOF`;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(Buffer.from(chunk.value));
        }
        assert.deepEqual(Buffer.concat(chunks), streamBytes);
      }
      phase = "OpenRouter abortable stream headers";
      const streamController = new AbortController();
      const abortable = await outboundFetch(`https://openrouter.ai${abortStreamPath}`, { signal: streamController.signal });
      assert.equal(abortable.status, 200);
      assert(abortedStreamClosed);
      phase = "OpenRouter abort rejects body read after headers";
      const body = abortable.arrayBuffer();
      streamController.abort();
      await assert.rejects(body, error => (error as Error).name === "AbortError");
      phase = "OpenRouter aborted stream closes both tunnel peers";
      await abortedStreamClosed;
      assert(authorities.length >= 4);
      assert(authorities.includes("api.telegram.org:443"));
      assert(authorities.includes("openrouter.ai:443"));
      if (authenticated) {
        const expected = socks ? `${username}:${password}` : `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
        assert(authentications.every(value => value === expected));
      } else assert(authentications.every(value => value === ""));
    }
  }
  console.log(`PASS ${scenario}`);
} catch (error) {
  console.error(`Failed during ${phase}; observed targets: ${authorities.join(", ")}; events: ${trace.join(", ")}`);
  throw error;
} finally {
  clearTimeout(watchdog);
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
}
