import { renderOgCard } from "../src/share";

// Offline native-render smoke test; exercise text, Cyrillic, escaping and preview.
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
for (const preview of [null, pixel]) {
  const response = renderOgCard("Привет, memes <&> — локальный PNG", ["мемы", "test<&>"], "example.org", preview, "Photo");
  const png = new Uint8Array(await response.arrayBuffer());
  const header = new DataView(png.buffer);
  if (response.headers.get("Content-Type") !== "image/png" || header.getUint32(0) !== 0x89504e47 || header.getUint32(16) !== 1200 || header.getUint32(20) !== 630) {
    throw new Error("Invalid OG PNG response");
  }
  console.log(`OG PNG ${preview ? "with preview" : "fallback"}: 1200x630, ${png.length} bytes`);
}
