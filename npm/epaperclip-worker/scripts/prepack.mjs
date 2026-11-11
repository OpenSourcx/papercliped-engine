// Fills worker/ before npm packs: the built worker CLI and the licence. Build it first:
//   pnpm --filter @papercliped-engine/worker-daemon build && cd npm/epaperclip-worker && npm pack
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const here = new URL("../", import.meta.url).pathname;
const repo = new URL("../../../", import.meta.url).pathname;
const bundle = `${repo}packages/worker-daemon/dist/epaperclip-worker.mjs`;
if (!existsSync(bundle)) {
  console.error(`prepack: ${bundle} is missing; run: pnpm --filter @papercliped-engine/worker-daemon build`);
  process.exit(1);
}
rmSync(`${here}worker`, { recursive: true, force: true });
mkdirSync(`${here}worker`);
cpSync(bundle, `${here}worker/epaperclip-worker.mjs`);
cpSync(`${repo}LICENSE`, `${here}LICENSE`);
console.error("prepack: worker bundle ready");
