// Fills payload/ from the release tarball before npm packs: the same files get.sh and the Debian package install.
//   pnpm build && node scripts/package-release.mjs <version> && cd npm/epaperclip && npm pack
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const here = new URL("../", import.meta.url).pathname;
const repo = new URL("../../../", import.meta.url).pathname;
const tarball = `${repo}release/epaperclip.tar.gz`;
if (!existsSync(tarball)) {
  console.error("prepack: release/epaperclip.tar.gz is missing; run: pnpm build && node scripts/package-release.mjs <version>");
  process.exit(1);
}
rmSync(`${here}payload`, { recursive: true, force: true });
mkdirSync(`${here}payload`);
execFileSync("tar", ["-xzf", tarball, "-C", `${here}payload`]);
for (const f of ["deploy/install.sh", "epaperclip.mjs", "engine/package-lock.json", "VERSION"]) {
  if (!existsSync(`${here}payload/epaperclip/${f}`)) { console.error(`prepack: the release has no ${f}`); process.exit(1); }
}
cpSync(`${repo}LICENSE`, `${here}LICENSE`);
console.error(`prepack: payload is release ${readFileSync(`${here}payload/epaperclip/VERSION`, "utf8").trim()}`);
