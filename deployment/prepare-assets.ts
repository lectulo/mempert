import { cp, mkdir } from "node:fs/promises";

// Preserve the package's relative font URLs and license alongside its CSS.
const target = new URL("../app/public/assets/design-system/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(new URL("../node_modules/@cofob2/design-system-css/dist/", import.meta.url), target, { recursive: true });
for (const name of ["LICENSE", "LICENSES"]) {
  await cp(new URL(`../node_modules/@cofob2/design-system-css/${name}`, import.meta.url), new URL(name, target), { recursive: true });
}
