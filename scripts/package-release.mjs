// Packs the built service and console, with the installer, into release/epaperclip.tar.gz (+ .sha256) and copies get.sh.
//   pnpm build && node scripts/package-release.mjs [version]
// The version defaults to the latest git tag or short commit. Users never build anything: get.sh downloads this.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url).pathname;
const bundle = `${root}services/epaperclip/dist/epaperclip.mjs`;
const consoleDir = `${root}apps/console/dist`;
for (const p of [bundle, `${consoleDir}/index.html`]) if (!existsSync(p)) { console.error(`package-release: ${p} is missing; run pnpm build first`); process.exit(1); }

const version = process.argv[2] ?? (() => { try { return execFileSync("git", ["describe", "--tags", "--always"], { cwd: root, encoding: "utf8" }).trim(); } catch { return "dev"; } })();
const out = `${root}release/`;
const dir = `${out}epaperclip/`;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${dir}deploy`, { recursive: true });
cpSync(bundle, `${dir}epaperclip.mjs`);
cpSync(consoleDir, `${dir}console`, { recursive: true });
for (const f of ["install.sh", "epaperclip.service", "epaperclip.default"]) cpSync(`${root}deploy/${f}`, `${dir}deploy/${f}`);
cpSync(`${root}LICENSE`, `${dir}LICENSE`);
writeFileSync(`${dir}VERSION`, `${version}\n`);

execFileSync("tar", ["-czf", `${out}epaperclip.tar.gz`, "-C", out, "epaperclip"]);
const sum = createHash("sha256").update(readFileSync(`${out}epaperclip.tar.gz`)).digest("hex");
writeFileSync(`${out}epaperclip.tar.gz.sha256`, `${sum}  epaperclip.tar.gz\n`);
cpSync(`${root}deploy/get.sh`, `${out}get.sh`);
rmSync(dir, { recursive: true });
console.log(`package-release: ${version} -> release/epaperclip.tar.gz (${sum.slice(0, 12)}…)`);
