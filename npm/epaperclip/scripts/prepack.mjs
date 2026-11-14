// Fills payload/ from the signed release before npm packs: the same tarball get.sh and the Debian package install, with its
// signed manifest and signature and the pinned public key. bin/epaperclip.js verifies them before it unpacks anything.
//   pnpm build && node scripts/package-release.mjs <version> && RELEASE_SIGNING_KEY=... node scripts/sign-release.mjs
//   && cd npm/epaperclip && npm pack
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";

const here = new URL("../", import.meta.url).pathname;
const repo = new URL("../../../", import.meta.url).pathname;
const need = (p, hint) => { if (!existsSync(p)) { console.error(`prepack: ${p} is missing; ${hint}`); process.exit(1); } };
need(`${repo}release/epaperclip.tar.gz`, "run: pnpm build && node scripts/package-release.mjs <version>");
need(`${repo}release/epaperclip.manifest.json`, "run scripts/sign-release.mjs (an unsigned release is never packed)");
need(`${repo}release/epaperclip.manifest.sig`, "run scripts/sign-release.mjs (an unsigned release is never packed)");
need(`${repo}deploy/release-signing.pub`, "run scripts/release-keygen.mjs once and commit the public key");
// The signed worker release rides in the same package, so `epaperclip --worker` works on a machine with no network to the project.
need(`${repo}release/epaperclip-worker.manifest.json`, "run scripts/package-worker.sh and scripts/sign-worker-release.mjs (an unsigned worker release is never packed)");
need(`${repo}release/epaperclip-worker.manifest.sig`, "run scripts/sign-worker-release.mjs (an unsigned worker release is never packed)");
const workerManifest = JSON.parse(readFileSync(`${repo}release/epaperclip-worker.manifest.json`, "utf8"));
if (!/^epaperclip-worker-[0-9A-Za-z.-]+\.tar\.gz$/.test(workerManifest.name ?? "")) { console.error("prepack: the worker manifest names no worker release file"); process.exit(1); }
need(`${repo}release/${workerManifest.name}`, "run scripts/package-worker.sh");
rmSync(`${here}payload`, { recursive: true, force: true });
mkdirSync(`${here}payload`);
for (const [from, to] of [["release/epaperclip.tar.gz", "epaperclip.tar.gz"], ["release/epaperclip.manifest.json", "epaperclip.manifest.json"], ["release/epaperclip.manifest.sig", "epaperclip.manifest.sig"], ["deploy/release-signing.pub", "release-signing.pub"], [`release/${workerManifest.name}`, workerManifest.name], ["release/epaperclip-worker.manifest.json", "epaperclip-worker.manifest.json"], ["release/epaperclip-worker.manifest.sig", "epaperclip-worker.manifest.sig"]]) cpSync(`${repo}${from}`, `${here}payload/${to}`);
cpSync(`${repo}LICENSE`, `${here}LICENSE`);
console.error(`prepack: payload is release ${JSON.parse(readFileSync(`${here}payload/epaperclip.manifest.json`, "utf8")).version} with worker release ${workerManifest.version} (${readdirSync(`${here}payload`).length} files)`);
