import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { buildConnector } from "undici/index.js";
import { customAIPost, isPublicAIAddress } from "../../src/aiprovidertransport";

test("AI transport rejects private, mapped, transition and metadata addresses", async () => {
  for (const ip of ["0.0.0.0", "127.1.2.3", "10.2.3.4", "192.168.1.2", "172.20.1.2", "100.100.100.200", "169.254.169.254",
    "168.63.129.16", "::1", "::ffff:10.2.3.4", "fd00:ec2::254", "fe80::1%eth0", "64:ff9b::a00:1", "2002:a00:1::", "224.0.0.1"])
    expect(isPublicAIAddress(ip)).toBe(false);
  for (const ip of ["8.8.8.8", "2606:4700::1111"]) expect(isPublicAIAddress(ip)).toBe(true);

  const noConnect = () => { throw new Error("must not dial"); };
  for (const addresses of [[], ["127.0.0.1"], ["8.8.8.8", "169.254.169.254"], ["fd00:ec2::254"]]) {
    const dns = async () => addresses.map((address) => ({ address }));
    await expect(customAIPost("https://provider.example/v1", "{}", "provider-key", undefined, dns, noConnect))
      .rejects.toThrow("AI provider requires public DNS addresses");
  }
});

test("AI transport dials a DNS snapshot, preserves authority and never follows a provider redirect", async () => {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, host: req.headers.host, authorization: req.headers.authorization });
    req.resume();
    if (requests.length === 1) res.end('{"ok":true}');
    else { res.writeHead(307, { Location: "https://redirected.example/" }); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const dnsNames: string[] = [];
    const dns = async (name: string) => {
      dnsNames.push(name);
      return [{ address: dnsNames.length < 3 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    };
    const dialed: unknown[] = [];
    const dial: ReturnType<typeof buildConnector> = (options, callback) => {
      dialed.push({ host: options.hostname, servername: options.servername, protocol: options.protocol, port: options.port });
      // Only the test connector substitutes a local HTTP socket for the public TLS socket.
      const socket = connect(address.port, "127.0.0.1", () => callback(null, socket));
    };
    const post = () => customAIPost("https://provider.example:8443/openai/v1", "{}", "provider-key", undefined, dns, dial);
    expect(await (await post()).json<{ ok: boolean }>()).toEqual({ ok: true });
    await expect(post()).rejects.toThrow("AI provider redirects are not allowed");
    await expect(post()).rejects.toThrow("AI provider requires public DNS addresses");
    expect(dnsNames).toEqual(Array(3).fill("provider.example."));
    expect(dialed).toEqual(Array(2).fill({ host: "8.8.8.8", servername: "provider.example", protocol: "https:", port: "8443" }));
    expect(requests).toEqual(Array(2).fill({ url: "/openai/v1/chat/completions", host: "provider.example:8443", authorization: "Bearer provider-key" }));
  } finally { server.close(); }
});
