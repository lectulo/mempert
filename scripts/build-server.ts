export {};
const result = await Bun.build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "bun",
  external: ["@resvg/resvg-js", "undici/index.js"],
  sourcemap: "external",
  plugins: [{ name: "oauth-worker-entrypoint", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: `${process.cwd()}/src/runtime/worker-shim.ts` }));
  } }],
});
if (!result.success) { console.error(result.logs); process.exit(1); }
