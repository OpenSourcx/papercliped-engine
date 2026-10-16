// Fills payload/ from the signed release before npm packs: the same tarball get.sh and the Debian package install, with its
// signed manifest and signature and the pinned public key. bin/epaperclip.js verifies them before it unpacks anything.
//   pnpm build && node scripts/package-release.mjs <version> && RELEASE_SIGNING_KEY=... node scripts/sign-release.mjs
//   && cd npm/epaperclip && npm pack
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const here = new URL("../", import.meta.url).pathname;
const repo = new URL("../../../", import.meta.url).pathname;
const need = (p, hint) => { if (!existsSync(p)) { console.error(`prepack: ${p} is missing; ${hint}`); process.exit(1); } };
need(`${repo}release/epaperclip.tar.gz`, "run: pnpm build && node scripts/package-release.mjs <version>");
need(`${repo}release/epaperclip.manifest.json`, "run scripts/sign-release.mjs (an unsigned release is never packed)");
need(`${repo}release/epaperclip.manifest.sig`, "run scripts/sign-release.mjs (an unsigned release is never packed)");
need(`${repo}deploy/release-signing.pub`, "run scripts/release-keygen.mjs once and commit the public key");
rmSync(`${here}payload`, { recursive: true, force: true });
mkdirSync(`${here}payload`);
for (const [from, to] of [["release/epaperclip.tar.gz", "epaperclip.tar.gz"], ["release/epaperclip.manifest.json", "epaperclip.manifest.json"], ["release/epaperclip.manifest.sig", "epaperclip.manifest.sig"], ["deploy/release-signing.pub", "release-signing.pub"]]) cpSync(`${repo}${from}`, `${here}payload/${to}`);
cpSync(`${repo}LICENSE`, `${here}LICENSE`);
console.error(`prepack: payload is release ${JSON.parse(readFileSync(`${here}payload/epaperclip.manifest.json`, "utf8")).version}`);
