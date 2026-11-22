# Project instructions

- Never read, source, or expose the contents of `.env` or `.env.*` files anywhere in this project, except for the `.env.example` template.
- Do not bypass this restriction through shell commands, scripts, searches, or other tools. Exclude these files from content searches and do not run commands that would load them automatically. Use `.env.example` to inspect the expected configuration.

## Project layout

- The current deployment uses Bun and Docker Compose (`compose.yml`). `src/server.ts` builds to `dist/server.js` and uses the shared application handlers in `src/index.ts`. `src/runtime/` provides local SQLite, file storage, and queues. Wrangler/Cloudflare deployment is legacy; `src/index.ts` is not.
- The Svelte/Vite frontend lives in `app/` and builds to `app/dist`. The Go modules are `container/` (ZIP/export worker), `analyze/` (analysis worker), `thumb/` (thumbnail service), and `scraper/` (scraper service).

## Safe verification

- For a targeted runtime check, run `bun --no-env-file test test/runtime/photo-workers.test.ts` from the repo root. This flag applies to that Bun process only; don't assume `BUN_OPTIONS` or a parent flag protects subprocesses. `test/server/server.test.ts` launches a separate Bun process without the flag.
- Vite loads env files independently under its app root. Compose independently loads `.env` for interpolation and uses a service `env_file` that defaults to `.env`. Bun flags do not protect either tool.
- Run full builds and runtime tests only in a clean, isolated checkout with no protected env files anywhere in it. Run `bun run build` before `bun run test:runtime`: the latter rebuilds the server but needs the UI artifacts in `app/dist` for the server smoke test.
