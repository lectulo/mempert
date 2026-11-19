import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Only this child trusts our generated CA. Never disable TLS verification in
// the test runner (other server tests may execute in the same process).
let directory: string;
beforeAll(() => {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  directory = mkdtempSync(join(process.cwd(), ".tmp/telegramproxy-"));
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Outbound transport test CA", "-addext", "subjectAltName=DNS:api.telegram.org,DNS:openrouter.ai,DNS:localhost,IP:127.0.0.1",
    "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")],
  { env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
  expect(generated.exitCode).toBe(0);
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

for (const scenario of ["http", "http-auth", "https", "https-auth", "socks5", "socks5-auth", "http-control", "socks5-control", "socks5-auth-control", "direct-unset", "direct-blank", "invalid", "rejected-auth"]) {
  test(`Telegram transport socket contract: ${scenario}`, async () => {
    // A fresh network namespace has no external interface or route. Even a
    // runtime silently ignoring its proxy agent cannot contact real Telegram.
    const child = Bun.spawn(["unshare", "--user", "--map-root-user", "--net", process.execPath, "--no-env-file", "test/proxy-wire/telegramproxy.fixture.ts", scenario, directory], {
      env: { PATH: process.env.PATH!, NODE_EXTRA_CA_CERTS: join(directory, "cert.pem") },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      // Undici emits this one known warning for its new SOCKS dispatcher.
      // Keep all other stderr fatal, including assertion/error stack traces.
      const diagnostics = stderr.replace(/^ExperimentalWarning: SOCKS5 proxy support is experimental and subject to change\n(?: +at [^\n]+\n)+\n/gm, "");
      expect({ exit, stdout, stderr: diagnostics }).toEqual({ exit: 0, stdout: `PASS ${scenario}\n`, stderr: "" });
    } finally { clearTimeout(deadline); }
  }, 20_000);
}
