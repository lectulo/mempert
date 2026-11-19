# Offline OAuth/MCP integration (Bun)

Run from the repository root:

```sh
nix run nixpkgs#bun -- test test/oauth-local
```

Or use `bun test test/oauth-local` when Bun is on PATH. The test builds its own
handler bundle under `test/oauth-local/.scratch/`, using the same WorkerEntrypoint
shim resolution as `scripts/build-server.ts`. It does not rebuild or change the
shared `dist` directory. Generated bundle and SQLite files are removed on exit.

The real OAuth provider, authorization handler, web account endpoints, MCP handler,
SQLite adapter and SQLite KV run together. Global fetch throws on **every** network
attempt; fake secrets and SQL fixtures are used. The Telegram session fixture is
independently HMAC-signed in the application's existing session format; auth checks
are neither replaced nor bypassed.

Covered: discovery and resource challenge; DCR with public-client PKCE; CIMD URL
rejection without fetching; anonymous and tampered-session rejection; escaped
consent HTML and browser-cookie binding; read-only consent; invalid PKCE rejection;
code exchange; MCP tool discovery, actual user-isolated `list_memes` and denied
`delete_memes`; new provider/KV and reopened SQLite at the same path; refresh and
another real tool call; connection listing/revocation; rejection of both access
tokens and the rotated refresh token after revocation.

Boundaries: handler-level integration, not an HTTP server/process restart. Restart
means closing/reopening SQLite and replacing provider/KV instances. Does not test
Telegram's login callback/network, external AI, media delivery, scheduled jobs,
write-enabled grants, token expiry or browser automation. Existing provider security
logs during negative assertions are expected. Replaying an already-exchanged code
can revoke the grant, so do not insert a replay assertion before using that grant.
