// Creates the shared-library links the engine's embedded PostgreSQL needs, at install time, as root.
//   node deploy/engine-links.mjs /opt/epaperclip.new/engine
//
// The PostgreSQL binaries ship with a list of symlinks (native/pg-symlinks.json) that their package's postinstall script
// would create. The installer runs npm with --ignore-scripts, so no third-party code runs as root; this does the same
// job from that list. It also adds the libfoo.so.N aliases the engine itself would try to create on every start, which
// it can't do once the tree is read-only and owned by root. Both are relative links inside native/lib, nothing else.
import { existsSync, readdirSync, readFileSync, symlinkSync, lstatSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const engine = process.argv[2];
if (!engine) { console.error("usage: node engine-links.mjs <engine dir>"); process.exit(2); }
const scope = join(engine, "node_modules", "@embedded-postgres");
const link = (target, path) => { try { lstatSync(path); } catch { symlinkSync(target, path); return 1; } return 0; };

let made = 0, found = 0;
for (const pkg of existsSync(scope) ? readdirSync(scope) : []) {
  const root = join(scope, pkg);
  const lib = join(root, "native", "lib");
  if (!existsSync(lib)) continue;
  found++;
  const listFile = join(root, "native", "pg-symlinks.json");
  const list = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")) : [];
  for (const { source, target } of list) {
    const src = resolve(root, source), dst = resolve(root, target);
    // Only links between files inside native/lib, as the package describes them.
    if (dirname(src) !== lib || dirname(dst) !== lib || !existsSync(src)) throw new Error(`unexpected link in ${listFile}: ${target} -> ${source}`);
    made += link(relative(lib, src), dst);
  }
  for (const f of readdirSync(lib, { withFileTypes: true })) {
    const m = f.isFile() && f.name.match(/^(lib.+\.so\.\d+)\.\d+(?:\.\d+)?$/);
    if (m) made += link(basename(f.name), join(lib, m[1]));
  }
}
if (!found) { console.error(`engine-links: no embedded PostgreSQL binaries under ${scope}`); process.exit(1); }
console.log(`engine-links: ${made} links created`);
