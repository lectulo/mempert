# Isolated outbound proxy wire contracts

Run from the repository root:

```sh
nix run nixpkgs#bun -- --no-env-file test test/proxy-wire
```

Prerequisites: Linux with unprivileged user/network namespaces enabled, `unshare`,
`ip`, and `openssl` on PATH. Unsupported hosts fail explicitly; there is no
unisolated fallback. This opt-in suite is intentionally outside `test:runtime`.

Every fixture child uses `--no-env-file`, a minimal environment, a private network
namespace with only loopback and no external routes, and its own generated trusted
certificate. No real Telegram or OpenRouter service is needed. TLS verification
remains enabled. Generated keys/certificates live in `.tmp` and are removed after
the suite.

Contracts cover HTTP CONNECT, HTTPS CONNECT (TLS to proxy), SOCKS5 remote DNS,
optional percent-encoded credentials, binary request/response preservation,
grammY getMe/multipart sendPhoto/long-poll cancellation and timeout, OpenRouter
JSON and OAuth-code POSTs, unset/blank direct mode, credential-safe errors, and
unrelated native fetch isolation. Proxies assert actual destination handshakes;
the origin checks application headers separately from proxy authentication.

Independent controls also prove the fixture itself: `SocksClient` completes the
SOCKS handshake, `SocksProxyAgent.connect` establishes verified TLS, and a raw TLS
client closes both TCP peers of a CONNECT long poll. On Bun, HTTPS server wrapper
`close` events are not reliable for unfinished responses, so cancellation checks
observe the two actual proxy TCP peers associated with that polling request.
The known Undici experimental SOCKS warning is accepted; other child stderr
remains a failure.
