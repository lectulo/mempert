# Real Go callback roundtrip

Run from the repository root, in a **separate Bun test process** (the test mocks
`node-fetch` for grammY, not OAuth behavior). No application `.env` is used to
construct the fixture; child binaries receive only explicit fixture variables.

```sh
mkdir -p .tmp/go-e2e .cache/go-build .cache/go-mod
export GOMAXPROCS=2
export GOCACHE="$PWD/.cache/go-build" GOMODCACHE="$PWD/.cache/go-mod"
export TMPDIR="$PWD/.tmp/go-e2e" XDG_CACHE_HOME="$PWD/.cache"
nix run nixpkgs#go -- -C container build -p 1 -o ../.tmp/go-e2e/zipimport .
nix run nixpkgs#go -- -C analyze build -p 1 -o ../.tmp/go-e2e/analyze .
nix run nixpkgs#bun -- test ./test/go-e2e/roundtrip.test.ts
```

The test starts real callback handlers on an ephemeral loopback port with fresh
SQLite, filesystem MEDIA, and local vectors. Real Go processes export one PNG
and its 1536-dimensional embeddings, restore it for another user, repeat the
restore to check deduplication, then generate analysis JSON and PNG charts.
It checks metadata, media bytes, vector namespace, queue silence, callback
authorization, completion state, and PNG signatures. Each child has a 90-second
timeout; its temporary directory is owned and deleted by this test.

Global fetch and grammY's node-fetch transport are intercepted. Only the three
expected Telegram sendMessage notifications receive local stub responses;
other outbound fetches fail the test. An empty cached mood-anchor set prevents
analysis from requesting OpenRouter embeddings. The Go binaries receive only
loopback callback/file URLs and do not use the launcher or dispatcher.

This is not an OS-level network sandbox and does not test production proxy,
launcher, ffmpeg, or OAuth behavior. The Workers module compatibility shim only
provides WorkerEntrypoint; OAuth itself is not mocked.
