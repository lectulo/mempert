// Run with: bun --no-env-file scripts/setup.check.ts (no Telegram requests).
import assert from "node:assert/strict";
import { setup, webhookConfig } from "./setup";

const checks: { name: string; run: () => void | Promise<void> }[] = [];
const test = (name: string, run: () => void | Promise<void>) => checks.push({ name, run });

const env = { TELEGRAM_MODE: "webhook", BOT_TOKEN: "123:test_secret", WEBHOOK_SECRET: "webhook_secret", PUBLIC_URL: "https://example.com/" };

test("default and explicit polling validate localhost without webhook/login secrets and never request Telegram", async () => {
  for (const mode of [undefined, "polling"]) {
    for (const args of [[], ["--dry-run"]]) {
      const messages: string[] = [];
      await setup({ TELEGRAM_MODE: mode, BOT_TOKEN: env.BOT_TOKEN, PUBLIC_URL: "http://localhost:3000" }, args,
        Object.assign(() => { throw new Error("must not fetch"); }, { preconnect: fetch.preconnect }), (message) => messages.push(message));
      assert.match(messages.join("\n"), /Polling managed by app; webhook setup not required/);
      assert.ok(!messages.join("\n").includes(env.BOT_TOKEN));
      if (args.length) assert.match(messages.join("\n"), /No requests sent/);
    }
  }
});

test("polling rejects destructive flags and invalid relevant configuration before any request", async () => {
  const polling = { BOT_TOKEN: env.BOT_TOKEN, PUBLIC_URL: "http://localhost:3000" };
  const noRequest = Object.assign(() => { throw new Error("must not fetch"); }, { preconnect: fetch.preconnect });
  for (const args of [["--drop-pending-updates"], ["--dry-run", "--drop-pending-updates"]]) {
    await assert.rejects(setup(polling, args, noRequest), /not allowed in polling/);
  }
  await assert.rejects(setup(polling, ["--unknown"], noRequest), /Usage/);
  await assert.rejects(setup({ ...polling, TELEGRAM_MODE: "other" }, [], noRequest), /TELEGRAM_MODE/);
  await assert.rejects(setup({ ...polling, BOT_TOKEN: "bad" }, [], noRequest), /BOT_TOKEN/);
  for (const value of [undefined, "", "ftp://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?secret=x", "https://example.com/#x"]) {
    await assert.rejects(setup({ ...polling, PUBLIC_URL: value }, ["--dry-run"], noRequest), /PUBLIC_URL/);
  }
});

test("server URL takes precedence; pending updates are preserved by default", () => {
  const config = webhookConfig({ ...env, WORKER_URL: "https://legacy.example" }, []);
  assert.equal(config.payload.url, "https://example.com/webhook");
  assert.equal(config.payload.drop_pending_updates, false);
  assert.equal(config.loginCallback, "https://example.com/auth/telegram/callback");
  assert.equal(webhookConfig({ ...env, PUBLIC_URL: undefined, WORKER_URL: "https://legacy.example" }, []).payload.url, "https://legacy.example/webhook");
  assert.equal(webhookConfig(env, ["--drop-pending-updates"]).payload.drop_pending_updates, true);
});

test("invalid configuration is rejected without echoing its values", () => {
  for (const value of ["", "http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com/?secret=x", "https://example.com/#x", "https://example.com:3000"]) {
    assert.throws(() => webhookConfig({ ...env, PUBLIC_URL: value }, []));
  }
  assert.throws(() => webhookConfig({ ...env, BOT_TOKEN: "bad" }, []));
  assert.throws(() => webhookConfig({ ...env, WEBHOOK_SECRET: "contains spaces" }, []));
  assert.throws(() => webhookConfig(env, ["--unknown"]));
});

test("dry run makes no requests and does not print credentials", async () => {
  const messages: string[] = [];
  await setup(env, ["--dry-run"], Object.assign(() => { throw new Error("must not fetch"); }, { preconnect: fetch.preconnect }), (message) => messages.push(message));
  assert.match(messages.join("\n"), /No requests sent/);
  assert.ok(!messages.join("\n").includes(env.BOT_TOKEN));
  assert.ok(!messages.join("\n").includes(env.WEBHOOK_SECRET));
});

test("setup always advertises ZIP import and reports whether OpenRouter batch commands will be published", async () => {
  for (const TELEGRAM_MODE of ["webhook", "polling"]) {
    const noRequest = Object.assign(() => { throw new Error("must not fetch"); }, { preconnect: fetch.preconnect });
    for (const BATCH_ENABLED of [undefined, "false"]) {
      const messages: string[] = [];
      await setup({ ...env, TELEGRAM_MODE, BATCH_ENABLED }, ["--dry-run"], noRequest, (message) => messages.push(message));
      assert.match(messages.join("\n"), BATCH_ENABLED === "false"
        ? /including ZIP import, without OpenRouter batch commands/
        : /including ZIP import and OpenRouter batch commands/);
    }
  }
});

test("default transport is not initialized for dry run or polling info", async () => {
  const messages: string[] = [];
  const log = (message: string) => messages.push(message);
  // Invalid proxy configuration must not matter: neither path uses the transport.
  const local = { ...env, OUTBOUND_PROXY_URL: "invalid://private:password@proxy.example" };
  const previousProxy = process.env.OUTBOUND_PROXY_URL;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  process.env.OUTBOUND_PROXY_URL = local.OUTBOUND_PROXY_URL;
  globalThis.fetch = Object.assign(() => {
    requests++;
    throw new Error("must not fetch");
  }, { preconnect: previousFetch.preconnect });
  try {
    await setup(local, ["--dry-run"], undefined, log);
    await setup({ ...local, TELEGRAM_MODE: "polling" }, [], undefined, log);
    await setup({ ...local, TELEGRAM_MODE: "polling" }, ["--dry-run"], undefined, log);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProxy === undefined) delete process.env.OUTBOUND_PROXY_URL;
    else process.env.OUTBOUND_PROXY_URL = previousProxy;
  }
  assert.equal(requests, 0);
  assert.match(messages.join("\n"), /No requests sent/);
  for (const secret of [env.BOT_TOKEN, env.WEBHOOK_SECRET, local.OUTBOUND_PROXY_URL]) {
    assert.ok(!messages.join("\n").includes(secret));
  }
});

test("apply sends the validated payload and ignores untrusted response text", async () => {
  const messages: string[] = [];
  const request = (async (url, init) => {
    assert.equal(url, `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`);
    assert.deepEqual(JSON.parse(String(init?.body)), webhookConfig(env, []).payload);
    return Response.json({ ok: true, description: env.BOT_TOKEN });
  }) as typeof fetch;
  await setup({ ...env, OUTBOUND_PROXY_URL: "socks5://private:password@proxy.example:1080" }, [], request, (message) => messages.push(message));
  assert.ok(!messages.join("\n").includes(env.BOT_TOKEN));
  assert.ok(!messages.join("\n").includes("private:password"));
});

test("API and network failures do not disclose secrets", async () => {
  await assert.rejects(setup(env, [], Object.assign(async () => { throw new Error(env.BOT_TOKEN); }, { preconnect: fetch.preconnect })), /network error or timeout/);
  await assert.rejects(setup(env, [], Object.assign(async () => Response.json({ ok: false, description: env.BOT_TOKEN }, { status: 401 }), { preconnect: fetch.preconnect })), /HTTP 401/);
});

for (const check of checks) {
  await check.run();
  console.log(`PASS ${check.name}`);
}
