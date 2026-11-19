// Run against an isolated fresh Compose project; no Telegram/OpenRouter calls.
const origin = process.env.SMOKE_ORIGIN ?? "http://127.0.0.1:13971";
for (const [path, contentType] of [
  ["/healthz", "application/json"], ["/", "text/html"],
  ["/assets/design-system/index.css", "text/css"],
  ["/assets/design-system/fonts/Manrope.woff2", "font/woff2"],
] as const) {
  const response = await fetch(origin + path);
  if (!response.ok || !response.headers.get("Content-Type")?.includes(contentType)) throw new Error(`Failed ${path}: ${response.status}`);
  console.log(path, response.status, (await response.arrayBuffer()).byteLength);
}
const privateResponse = await fetch(origin + "/internal/jobs/zip/claim", { method: "POST" });
if (privateResponse.status !== 401) throw new Error(`Dispatcher exposed: ${privateResponse.status}`);
console.log("Unauthenticated dispatcher: 401");
